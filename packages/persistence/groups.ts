/** 父子任务复用原执行状态机；创建、等待和聚合提交保持原子，不重新发送业务动作。 */
import {
  Problem,
  requireCapability,
  type Action,
  type Principal,
  type Task,
  type Step,
} from "../contracts/index.js";
import type { Registry } from "../runtime/registry.js";
import { ExecutionStore } from "./execution.js";
import { TaskStore, event, lockTaskTree } from "./tasks.js";
export class TaskGroups {
  constructor(
    private tasks: TaskStore,
    private execution: ExecutionStore,
    private registry: Registry,
  ) {}
  async spawn(
    task: Task,
    step: Step,
    action: Extract<Action, { kind: "children" }>,
    principal: Principal,
  ) {
    if (!action.children.length || action.children.length > 20)
      throw new Problem(422, "CHILD_LIMIT_EXCEEDED");
    await this.tasks.db.transaction(async (client) => {
      await lockTaskTree(client, task.id);
      await this.execution.lock(client, task);
      const depth = (
        await client.query<{ depth: number }>(
          "WITH RECURSIVE parents AS (SELECT id,parent_id,1 AS depth FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,p.depth+1 FROM tasks t JOIN parents p ON t.id=p.parent_id) SELECT max(depth)::integer AS depth FROM parents",
          [task.id],
        )
      ).rows[0]!.depth;
      if (depth >= 4) throw new Problem(422, "TASK_DEPTH_EXCEEDED");
      const existing = await client.query(
        "SELECT 1 FROM task_groups WHERE step_id=$1",
        [step.id],
      );
      if (existing.rowCount) {
        await this.suspend(client, task);
        return;
      }
      const used = (
        await client.query<{ count: string }>(
          "WITH RECURSIVE tree AS (SELECT id FROM tasks WHERE id=$1 UNION ALL SELECT t.id FROM tasks t JOIN tree p ON t.parent_id=p.id) SELECT count(*) FROM steps WHERE task_id IN (SELECT id FROM tree)",
          [task.id],
        )
      ).rows[0]!;
      const count = action.children.length;
      const perChild = {
        ...task.budget,
        maxSteps: Math.floor(
          (task.budget.maxSteps - Number(used.count)) / count,
        ),
        maxModelCalls: Math.floor(
          (task.budget.maxModelCalls - task.model_calls) / count,
        ),
        maxToolCalls: Math.floor(
          (task.budget.maxToolCalls - task.tool_calls) / count,
        ),
        maxDurationMs: Math.floor(
          (task.budget.maxDurationMs - Number(task.execution_ms)) / count,
        ),
        maxCostUsd: Math.max(
          0,
          (task.budget.maxCostUsd - Number(task.cost_usd)) / count,
        ),
      };
      if (perChild.maxSteps < 1 || perChild.maxDurationMs < 1)
        throw new Problem(422, "CHILD_BUDGET_EXCEEDED");
      const ids: string[] = [];
      for (const [index, spec] of action.children.entries()) {
        const module = this.registry.get(spec.moduleId);
        requireCapability(principal, module.capability);
        const child = await this.tasks.createInTransaction(
          client,
          principal,
          spec.moduleId,
          spec.input,
          `child:${task.id}:${step.id}:${index}`,
          task.conversation_id,
        );
        const budget = Object.fromEntries(
          Object.entries(perChild).map(([key, value]) => [
            key,
            Math.min(value, child.budget[key as keyof typeof perChild]),
          ]),
        );
        await client.query(
          "UPDATE tasks SET parent_id=$2,execution_scope=$3,budget=$4 WHERE id=$1",
          [child.id, task.id, principal.capabilities, JSON.stringify(budget)],
        );
        ids.push(child.id);
      }
      await client.query(
        "INSERT INTO task_groups(step_id,parent_id,child_ids,failure_policy) VALUES($1,$2,$3,$4)",
        [step.id, task.id, ids, action.onFailure ?? "fail"],
      );
      await event(client, task.id, "children.created", {
        stepId: step.id,
        children: ids,
      });
      await this.suspend(client, task);
    });
  }
  private async suspend(client: import("pg").PoolClient, task: Task) {
    await client.query(
      "UPDATE tasks SET status='waiting_external',lease_token=NULL,lease_until=NULL WHERE id=$1",
      [task.id],
    );
    await client.query(
      "UPDATE runs SET status='waiting',ended_at=now() WHERE id=$1",
      [task.run_id],
    );
  }
  async tick() {
    await this.tasks.db.transaction(async (client) => {
      const groups = (
        await client.query<{
          step_id: string;
          parent_id: string;
          child_ids: string[];
          usage: Record<string, number>;
          failure_policy: "fail" | "collect";
        }>(
          "SELECT g.* FROM task_groups g JOIN tasks p ON p.id=g.parent_id WHERE NOT g.settled AND p.status='waiting_external' AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.id=ANY(g.child_ids) AND c.status NOT IN ('succeeded','failed','cancelled')) ORDER BY p.created_at FOR UPDATE OF p,g SKIP LOCKED LIMIT 20",
        )
      ).rows;
      for (const group of groups) {
        const children = (
          await client.query<Task>(
            "SELECT * FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
            [group.child_ids],
          )
        ).rows;
        const failed = children.some((c) => c.status !== "succeeded");
        const stop = failed && group.failure_policy !== "collect";
        const output = group.child_ids.map((id) => {
          const child = children.find((c) => c.id === id)!;
          return {
            id,
            status: child.status,
            result: child.result,
            error: child.error,
          };
        });
        await client.query("UPDATE steps SET status=$2,output=$3 WHERE id=$1", [
          group.step_id,
          stop ? "failed" : "succeeded",
          JSON.stringify(output),
        ]);
        const sum = (
          key: "cost_usd" | "model_calls" | "tool_calls" | "execution_ms",
        ) => children.reduce((total, child) => total + Number(child[key]), 0);
        await client.query(
          "UPDATE tasks SET status=$2,error=$3,cost_usd=cost_usd+$4,model_calls=model_calls+$5,tool_calls=tool_calls+$6,execution_ms=execution_ms+$7,available_at=now(),updated_at=now() WHERE id=$1",
          [
            group.parent_id,
            stop ? "failed" : "queued",
            stop ? "CHILD_TASK_FAILED" : null,
            sum("cost_usd") - (group.usage.cost_usd ?? 0),
            sum("model_calls") - (group.usage.model_calls ?? 0),
            sum("tool_calls") - (group.usage.tool_calls ?? 0),
            sum("execution_ms") - (group.usage.execution_ms ?? 0),
          ],
        );
        await client.query(
          "UPDATE task_groups SET settled=true,usage=$2 WHERE step_id=$1",
          [
            group.step_id,
            JSON.stringify({
              cost_usd: sum("cost_usd"),
              model_calls: sum("model_calls"),
              tool_calls: sum("tool_calls"),
              execution_ms: sum("execution_ms"),
            }),
          ],
        );
        await event(client, group.parent_id, "children.settled", {
          stepId: group.step_id,
          failed,
        });
      }
    });
  }
}
