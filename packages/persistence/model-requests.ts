/** 在短事务内持久化调用和资源准入；远端 IO 必须发生在提交之后。 */
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";
import type { Task, Step } from "../contracts/index.js";
import { Problem } from "../contracts/index.js";
import { ExecutionFailure } from "../contracts/failure.js";
import type {
  ModelReceipt,
  ModelLifecyclePolicy,
} from "../contracts/model-lifecycle.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { ModelLedger, ModelRequestRow } from "../runtime/model-ledger.js";
export {
  invocationReference,
  type ModelRequestRow,
} from "../runtime/model-ledger.js";
export class ModelRequestStore implements ModelLedger {
  constructor(private db: Database) {}
  async begin(
    task: Task,
    step: Step,
    engineId: string,
    policy: ModelLifecyclePolicy,
    deadlineAt: number,
    requestHash: string,
  ) {
    // 失联状态单独提交，后续准入被拒绝也不能回滚这次恢复事实。
    await this.expire();
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `model-resource:${policy.resourceId}`,
      ]);
      const lease = await c.query(
        "SELECT id FROM tasks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
        [task.id, task.lease_token],
      );
      if (!lease.rowCount) throw new Problem(409, "LEASE_LOST");
      const active = await c.query<{
        same: boolean;
        total: number;
        uncertain: number;
      }>(
        `SELECT (SELECT EXISTS(SELECT 1 FROM model_requests WHERE step_id=$2 AND state IN ('running','cancelling','unknown') AND quarantine_until>clock_timestamp())) AS same,count(*)::int AS total,
        count(*) FILTER(WHERE state<>'running')::int AS uncertain FROM model_requests
        WHERE resource_id=$1 AND state IN ('running','cancelling','unknown') AND quarantine_until>clock_timestamp()`,
        [policy.resourceId, step.id],
      );
      const row = active.rows[0]!;
      if (row.same || row.uncertain >= (policy.unknownLimit ?? 4))
        throw new ExecutionFailure("transient", "MODEL_REMOTE_UNCERTAIN", {
          retryAfterMs: 5000,
          notAccepted: true,
        });
      if (row.total >= (policy.concurrency ?? 16))
        throw new ExecutionFailure("transient", "MODEL_CAPACITY_EXCEEDED", {
          retryAfterMs: 1000,
          notAccepted: true,
        });
      const id = randomUUID();
      const result = await c.query<ModelRequestRow>(
        `INSERT INTO model_requests(id,task_id,step_id,run_id,lease_token,operation_key,engine_id,resource_id,cost_invocation,state,deadline_at,quarantine_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11) RETURNING *`,
        [
          id,
          task.id,
          step.id,
          task.run_id,
          task.lease_token,
          fingerprint({
            workspace: task.workspace_id,
            principal: task.principal_id,
            task: task.id,
            step: step.id,
            requestHash,
          }),
          engineId,
          policy.resourceId,
          `${step.id}:${task.run_id}`,
          new Date(deadlineAt),
          new Date(deadlineAt + (policy.quarantineMs ?? 60000)),
        ],
      );
      return result.rows[0]!;
    });
  }
  async expire(client: Pick<PoolClient, "query"> = this.db.pool) {
    await client.query(`UPDATE model_requests m SET state='unknown',updated_at=now()
      WHERE state='running' AND (deadline_at<=clock_timestamp() OR NOT EXISTS
      (SELECT 1 FROM tasks t WHERE t.id=m.task_id AND t.status='running' AND t.lease_token=m.lease_token AND t.lease_until>clock_timestamp()))`);
  }
  async uncertain(id: string) {
    await this.db.pool.query(
      "UPDATE model_requests SET state='cancelling',updated_at=now() WHERE id=$1 AND state='running'",
      [id],
    );
  }
  async receipt(id: string, receipt: ModelReceipt) {
    const usage = receipt.usage;
    if (usage && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0))
      throw new Problem(422, "INVALID_MODEL_COST");
    const terminal = ["not_started", "completed"].includes(receipt.state);
    return this.db.transaction(async (client) => {
      const result = await client.query<{ cost_invocation: string }>(
        `UPDATE model_requests SET state=CASE WHEN $2='running' AND state<>'running' THEN 'unknown' ELSE $2 END,remote_state=$3,
      quarantine_until=CASE WHEN $4 THEN now() ELSE quarantine_until END,
      cost_usd=coalesce($5,cost_usd),usage_complete=CASE WHEN $5 IS NULL THEN usage_complete ELSE $6 END,
      cost_estimated=CASE WHEN $5 IS NULL THEN cost_estimated ELSE $7 END,updated_at=now(),reconciled_at=now()
      WHERE id=$1 AND state NOT IN ('completed','not_started') RETURNING cost_invocation`,
        [
          id,
          terminal || receipt.state === "running" ? receipt.state : "unknown",
          receipt.state,
          terminal,
          usage?.costUsd ?? null,
          usage?.complete ?? false,
          usage?.estimated ?? true,
        ],
      );
      if (
        result.rowCount &&
        (receipt.state === "not_started" || usage?.complete)
      ) {
        await client.query(
          "UPDATE cost_reservations SET charged=$2,category=$3 WHERE invocation=$1 AND category='pending'",
          [
            result.rows[0]!.cost_invocation,
            receipt.state === "not_started" ? 0 : usage!.costUsd,
            receipt.state === "not_started" || !usage?.estimated
              ? "reported"
              : "estimated",
          ],
        );
      }
      return !!result.rowCount;
    });
  }
  async pending() {
    await this.expire();
    return (
      await this.db.pool
        .query<ModelRequestRow>(`SELECT * FROM model_requests WHERE state IN ('unknown','cancelling')
      AND quarantine_until>now() AND (reconciled_at IS NULL OR reconciled_at<now()-interval '5 seconds')
      ORDER BY reconciled_at NULLS FIRST,created_at LIMIT 8`)
    ).rows;
  }
  async prune() {
    await this.db.pool.query(
      "DELETE FROM model_requests WHERE state IN ('completed','not_started','unknown') AND quarantine_until<now()-interval '30 days'",
    );
  }
}
