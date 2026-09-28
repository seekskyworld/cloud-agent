import { retryDelay } from "../contracts/failure.js";
/** 执行提交只接受有效租约；过期 Worker 不能覆盖恢复后的任务状态。 */
import type { DispatchPolicy } from "../runtime/admission.js";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  Problem,
  type Action,
  type Json,
  type Outcome,
  type Step,
  type Task,
  type Tool,
} from "../contracts/index.js";
import { Database } from "./database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { Registry } from "../runtime/registry.js";
import { event } from "./tasks.js";
export class ExecutionStore {
  constructor(
    readonly db: Database,
    private registry: Registry,
    readonly leaseMs = 30_000,
    private policy: DispatchPolicy = {},
    private pool = "default",
    private labels: string[] = [],
  ) {}
  async claim(
    engineId: string | ((task: Task) => string),
  ): Promise<Task | undefined> {
    return this.db.transaction(async (client) => {
      if (
        (await client.query("SELECT runtime_maintenance_enabled() AS enabled"))
          .rows[0]?.enabled
      )
        return;
      // 准入计数与新租约在同一短事务串行化，避免多个 Worker 同时越过上限。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cloud-agent-admission'))",
      );
      const task = (
        await client.query<Task>(
          `SELECT * FROM tasks t WHERE ((status IN ('queued','retry_scheduled') AND available_at<=now()) OR (status='running' AND lease_until<now()))
          AND t.execution_pool=$3 AND t.execution_labels <@ $4::text[]
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS m(id text,version text,hash text)
            WHERE m.id=t.module_id AND m.version=t.module_version AND m.hash=t.config_hash)
          AND (SELECT count(*) FROM tasks active WHERE active.workspace_id=t.workspace_id AND active.status='running' AND active.lease_until>now())
            < COALESCE(($2::jsonb->'workspaces'->>t.workspace_id)::integer,($2::jsonb->>'workspaceConcurrency')::integer,2147483647)
          AND (SELECT count(*) FROM tasks active WHERE active.workspace_id=t.workspace_id AND active.module_id=t.module_id AND active.status='running' AND active.lease_until>now())
            < COALESCE(($2::jsonb->'modules'->>t.module_id)::integer,2147483647)
          ORDER BY COALESCE((SELECT max(turn) FROM dispatch_turns d WHERE d.workspace_id=t.workspace_id),0),
            COALESCE((SELECT turn FROM dispatch_turns d WHERE d.workspace_id=t.workspace_id AND d.module_id=t.module_id),0),available_at,created_at
          FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
          [
            JSON.stringify(this.registry.compatible()),
            JSON.stringify(this.policy),
            this.pool,
            this.labels,
          ],
        )
      ).rows[0];
      if (!task) return;
      await client.query(
        "INSERT INTO dispatch_turns(workspace_id,module_id,turn) VALUES($1,$2,nextval('dispatch_sequence')) ON CONFLICT(workspace_id,module_id) DO UPDATE SET turn=EXCLUDED.turn",
        [task.workspace_id, task.module_id],
      );
      const token = randomUUID();
      const run = randomUUID();
      await client.query(
        "UPDATE runs SET status='lease_expired',ended_at=now() WHERE task_id=$1 AND status='running'",
        [task.id],
      );
      await client.query(
        "UPDATE tasks SET status='running',lease_token=$2,lease_until=now()+$3*interval '1 millisecond',updated_at=now() WHERE id=$1",
        [task.id, token, this.leaseMs],
      );
      await client.query(
        "INSERT INTO runs(id,task_id,lease_token,engine_id) VALUES($1,$2,$3,$4)",
        [
          run,
          task.id,
          token,
          typeof engineId === "string" ? engineId : engineId(task),
        ],
      );
      await event(client, task.id, "run.started", {
        runId: run,
        recovered: task.status === "running",
      });
      return { ...task, status: "running", lease_token: token, run_id: run };
    });
  }
  async lock(client: PoolClient, task: Task): Promise<void> {
    const found = await client.query(
      "SELECT id FROM tasks WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
      [task.id, task.lease_token],
    );
    if (!found.rowCount) throw new Problem(409, "LEASE_LOST");
  }
  async heartbeat(task: Task): Promise<boolean> {
    const result = await this.db.pool.query(
      "UPDATE tasks SET lease_until=now()+$3*interval '1 millisecond' WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now()",
      [task.id, task.lease_token, this.leaseMs],
    );
    return !!result.rowCount;
  }
  async steps(taskId: string): Promise<Step[]> {
    return (
      await this.db.pool.query<Step>(
        "SELECT * FROM steps WHERE task_id=$1 ORDER BY created_at,id",
        [taskId],
      )
    ).rows;
  }
  async prepare(
    task: Task,
    action: Exclude<Action, { kind: "complete" }>,
    tool?: Tool,
  ): Promise<Step> {
    return this.db.transaction(async (client) => {
      await this.lock(client, task);
      const hash = fingerprint(action);
      const existing = (
        await client.query<Step & { request_hash: string }>(
          "SELECT * FROM steps WHERE task_id=$1 AND key=$2",
          [task.id, action.key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== hash)
          throw new Problem(409, "STEP_INPUT_CHANGED");
        return existing;
      }
      const count = (
        await client.query<{ count: string }>(
          "WITH RECURSIVE tree AS (SELECT id FROM tasks WHERE id=$1 UNION ALL SELECT t.id FROM tasks t JOIN tree p ON t.parent_id=p.id) SELECT count(*) FROM steps WHERE task_id IN (SELECT id FROM tree)",
          [task.id],
        )
      ).rows[0]!;
      if (Number(count.count) >= task.budget.maxSteps)
        throw new Problem(422, "STEP_BUDGET_EXCEEDED");
      const step = (
        await client.query<Step>(
          "INSERT INTO steps(id,task_id,key,kind,request,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *",
          [
            randomUUID(),
            task.id,
            action.key,
            action.kind,
            JSON.stringify(action),
            hash,
          ],
        )
      ).rows[0]!;
      if (tool)
        await client.query(
          "INSERT INTO tool_invocations(id,task_id,tool_name,tool_version,effect,status) VALUES($1,$2,$3,$4,$5,'pending')",
          [step.id, task.id, tool.name, tool.version, tool.effect],
        );
      return step;
    });
  }
  async begin(task: Task, step: Step): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.lock(client, task);
      if (step.attempts >= task.budget.maxAttempts)
        throw new Problem(422, "ATTEMPT_BUDGET_EXCEEDED");
      const counter = step.kind === "model" ? "model_calls" : "tool_calls";
      const max =
        step.kind === "model"
          ? task.budget.maxModelCalls
          : task.budget.maxToolCalls;
      const updated = await client.query(
        `UPDATE tasks SET ${counter}=${counter}+1 WHERE id=$1 AND ${counter}<$2 AND execution_ms<$3 AND cost_usd<$4`,
        [task.id, max, task.budget.maxDurationMs, task.budget.maxCostUsd],
      );
      if (!updated.rowCount)
        throw new Problem(422, "EXECUTION_BUDGET_EXCEEDED");
      await client.query(
        "UPDATE steps SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1",
        [step.id],
      );
      await client.query(
        "UPDATE tool_invocations SET status='dispatching',updated_at=now() WHERE id=$1",
        [step.id],
      );
      await client.query(
        "INSERT INTO invocation_attempts(step_id,run_id,status) VALUES($1,$2,'running')",
        [step.id, task.run_id],
      );
      await event(client, task.id, `${step.kind}.started`, {
        stepId: step.id,
        key: step.key,
      });
    });
  }
  async checkpointModel(
    task: Task,
    step: Step,
    output: Json,
    checkpointHash: string,
    elapsed: number,
    cost: number,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.lock(client, task);
      const updated = await client.query(
        `UPDATE steps SET status='checkpointed',output=$2,checkpoint_hash=$3,
         checkpoint_elapsed_ms=$4,checkpoint_cost_usd=$5,updated_at=now()
         WHERE id=$1 AND status='running' AND task_id=$6 AND kind='model'`,
        [
          step.id,
          JSON.stringify(output),
          checkpointHash,
          elapsed,
          cost,
          task.id,
        ],
      );
      if (!updated.rowCount) throw new Problem(409, "STEP_STATE_CHANGED");
    });
  }
  async resumeCheckpoint(
    task: Task,
    step: Step,
    checkpointHash: string,
  ): Promise<boolean> {
    return this.db.transaction(async (client) => {
      await this.lock(client, task);
      const row = (
        await client.query<{
          output: Json;
          checkpoint_elapsed_ms: number | null;
          checkpoint_cost_usd: number | null;
        }>(
          `SELECT output,checkpoint_elapsed_ms,checkpoint_cost_usd FROM steps
           WHERE id=$1 AND status='checkpointed' AND checkpoint_hash=$2 AND task_id=$3 FOR UPDATE`,
          [step.id, checkpointHash, task.id],
        )
      ).rows[0];
      if (!row) return false;
      await client.query(
        "UPDATE tasks SET execution_ms=execution_ms+$2,cost_usd=cost_usd+$3 WHERE id=$1",
        [
          task.id,
          Math.max(0, row.checkpoint_elapsed_ms ?? 0),
          Math.max(0, row.checkpoint_cost_usd ?? 0),
        ],
      );
      await client.query(
        "UPDATE invocation_attempts SET status='succeeded',ended_at=now() WHERE step_id=$1 AND status='running'",
        [step.id],
      );
      await client.query(
        "UPDATE steps SET status='succeeded',updated_at=now() WHERE id=$1",
        [step.id],
      );
      await this.release(client, task, "queued");
      await event(client, task.id, "model.succeeded", {
        stepId: step.id,
        checkpointReused: true,
      });
      return true;
    });
  }
  /** 失配结果不可复用，但已发生的调用费用与耗时不能被清零。 */
  async invalidateCheckpoint(task: Task, step: Step): Promise<Task> {
    return this.db.transaction(async (client) => {
      await this.lock(client, task);
      const updated = await client.query<Task>(
        `UPDATE tasks SET
           execution_ms=execution_ms+coalesce(s.checkpoint_elapsed_ms,0),
           cost_usd=cost_usd+coalesce(s.checkpoint_cost_usd,0)
         FROM steps s WHERE tasks.id=$1 AND s.task_id=tasks.id
           AND s.id=$2 AND s.status='checkpointed' RETURNING tasks.*`,
        [task.id, step.id],
      );
      if (!updated.rows[0]) throw new Problem(409, "STEP_STATE_CHANGED");
      await client.query(
        "UPDATE invocation_attempts SET status='checkpoint_invalidated',ended_at=now() WHERE step_id=$1 AND status='running'",
        [step.id],
      );
      await client.query(
        `UPDATE steps SET status='pending',output=NULL,checkpoint_hash=NULL,
         checkpoint_elapsed_ms=NULL,checkpoint_cost_usd=NULL,updated_at=now()
         WHERE id=$1 AND status='checkpointed'`,
        [step.id],
      );
      await event(client, task.id, "model.checkpoint_invalidated", {
        stepId: step.id,
      });
      return { ...updated.rows[0], run_id: task.run_id };
    });
  }
  async release(
    client: PoolClient,
    task: Task,
    status: string,
    delayMs = 0,
  ): Promise<void> {
    await client.query(
      "UPDATE tasks SET status=$2,lease_token=NULL,lease_until=NULL,available_at=now()+$3*interval '1 millisecond',updated_at=now() WHERE id=$1",
      [task.id, status, delayMs],
    );
    await client.query("UPDATE runs SET status=$2,ended_at=now() WHERE id=$1", [
      task.run_id,
      status,
    ]);
  }
  async finish(
    task: Task,
    step: Step,
    outcome: Outcome,
    elapsed: number,
    cost = 0,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.lock(client, task);
      await client.query(
        "UPDATE tasks SET execution_ms=execution_ms+$2,cost_usd=cost_usd+$3 WHERE id=$1",
        [task.id, Math.max(0, elapsed), cost],
      );
      await client.query(
        "UPDATE invocation_attempts SET status=$3,ended_at=now() WHERE step_id=$1 AND run_id=$2",
        [step.id, task.run_id, outcome.kind],
      );
      await client.query(
        "UPDATE tool_invocations SET status=$2,receipt=$3,reconciliation_ref=$4,updated_at=now() WHERE id=$1",
        [
          step.id,
          outcome.kind,
          outcome.kind === "succeeded" ? (outcome.receipt ?? null) : null,
          outcome.kind === "unknown" ? outcome.reconciliationRef : null,
        ],
      );
      await this.applyOutcome(client, task, step, outcome);
      await event(client, task.id, `${step.kind}.${outcome.kind}`, {
        stepId: step.id,
        ...(outcome.kind === "succeeded" ? {} : outcome),
      });
    });
  }
  private async applyOutcome(
    client: PoolClient,
    task: Task,
    step: Step,
    outcome: Outcome,
  ) {
    if (outcome.kind === "succeeded") {
      await client.query(
        "UPDATE steps SET status='succeeded',output=$2,updated_at=now() WHERE id=$1",
        [step.id, JSON.stringify(outcome.output)],
      );
      return this.release(client, task, "queued");
    }
    if (outcome.kind === "retryable") {
      await client.query("UPDATE steps SET status='pending' WHERE id=$1", [
        step.id,
      ]);
      return this.release(
        client,
        task,
        "retry_scheduled",
        retryDelay(outcome.retryAfterMs, step.attempts),
      );
    }
    if (outcome.kind === "unknown") {
      await client.query("UPDATE steps SET status='unknown' WHERE id=$1", [
        step.id,
      ]);
      return this.release(client, task, "waiting_external");
    }
    await client.query(
      "UPDATE steps SET status='failed',output=$2 WHERE id=$1",
      [step.id, JSON.stringify(outcome)],
    );
    await client.query("UPDATE tasks SET error=$2 WHERE id=$1", [
      task.id,
      outcome.code,
    ]);
    return this.release(client, task, "failed");
  }
  async fail(task: Task, code: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.lock(client, task);
      await client.query("UPDATE tasks SET error=$2 WHERE id=$1", [
        task.id,
        code,
      ]);
      await this.release(client, task, "failed");
      await event(client, task.id, "task.failed", { code });
    });
  }
  async complete(task: Task, result: Json, title: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.lock(client, task);
      await client.query("UPDATE tasks SET result=$2,error=NULL WHERE id=$1", [
        task.id,
        JSON.stringify(result),
      ]);
      await client.query(
        "INSERT INTO artifacts(id,task_id,title,content) VALUES($1,$2,$3,$4)",
        [randomUUID(), task.id, title, JSON.stringify(result)],
      );
      await client.query(
        "INSERT INTO messages(conversation_id,task_id,role,content) VALUES($1,$2,'assistant',$3)",
        [task.conversation_id, task.id, JSON.stringify(result)],
      );
      await this.release(client, task, "succeeded");
      await event(client, task.id, "task.succeeded");
    });
  }
}
