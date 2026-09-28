/** 月度额度在数据库中原子预留；无回执的模型调用继续占用额度，防止断线后重复透支。 */
import { CostResolution } from "../contracts/governance.js";
import { governanceCommand } from "../persistence/governance.js";
import type { Principal } from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import { Problem, type Task } from "../contracts/index.js";
export interface CostPolicy {
  workspaces: Record<string, number>;
  modules?: Record<string, number>;
}
export class WorkspaceCosts {
  constructor(
    private db: Database,
    private policy: CostPolicy = { workspaces: {} },
  ) {}
  async reserve(task: Task, invocation: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Problem(422, "COST_BUDGET_EXCEEDED");
    const limits = [
      {
        scope: `workspace:${task.workspace_id}`,
        limit: this.policy.workspaces[task.workspace_id],
      },
      {
        scope: `module:${task.workspace_id}:${task.module_id}`,
        limit: this.policy.modules?.[task.module_id],
      },
    ]
      .filter(
        (l): l is { scope: string; limit: number } => l.limit !== undefined,
      )
      .sort((a, b) => a.scope.localeCompare(b.scope));
    if (!limits.length) return;
    await this.db.transaction(async (client) => {
      for (const { scope, limit } of limits) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          scope,
        ]);
        const previous = await client.query(
          "SELECT 1 FROM cost_reservations WHERE scope=$1 AND invocation=$2",
          [scope, invocation],
        );
        if (previous.rowCount) continue;
        const row = (
          await client.query<{ total: number }>(
            "SELECT coalesce(sum(coalesce(charged,reserved)),0)::double precision AS total FROM cost_reservations WHERE scope=$1 AND period=date_trunc('month',now())::date",
            [scope],
          )
        ).rows[0]!;
        if (row.total + amount > limit)
          throw new Problem(429, "WORKSPACE_COST_LIMIT");
        await client.query(
          "INSERT INTO cost_reservations(scope,invocation,workspace_id,task_id,period,reserved) VALUES($1,$2,$3,$4,date_trunc('month',now())::date,$5)",
          [scope, invocation, task.workspace_id, task.id, amount],
        );
      }
    });
  }
  async settle(invocation: string, amount: number, estimated: boolean) {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Problem(422, "INVALID_MODEL_COST");
    await this.db.pool.query(
      "UPDATE cost_reservations SET charged=$2,category=$3 WHERE invocation=$1 AND category='pending'",
      [invocation, amount, estimated ? "estimated" : "reported"],
    );
  }
  async pending(workspace: string) {
    return (
      await this.db.pool.query(
        "SELECT invocation,task_id,max(reserved) AS reserved,max(charged) AS charged,min(category) AS category FROM cost_reservations WHERE workspace_id=$1 AND category IN ('pending','estimated') GROUP BY invocation,task_id ORDER BY invocation LIMIT 100",
        [workspace],
      )
    ).rows;
  }
  async resolve(actor: Principal, key: string, raw: unknown) {
    const input = CostResolution.parse(raw);
    await this.db.transaction(async (client) => {
      if (
        !(await governanceCommand(
          client,
          actor,
          "cost:reconcile",
          key,
          "cost",
          input.invocation,
          input,
        ))
      )
        return;
      const rows = await client.query<{ category: string }>(
        "SELECT category FROM cost_reservations WHERE invocation=$1 AND workspace_id=$2 FOR UPDATE",
        [input.invocation, actor.workspace_id],
      );
      if (!rows.rowCount) throw new Problem(404, "COST_NOT_FOUND");
      if (rows.rows.some((r) => r.category !== input.expected))
        throw new Problem(409, "COST_VERSION_CONFLICT");
      await client.query(
        "UPDATE cost_reservations SET category='reconciled',charged=$3,reason=$4,receipt=$5 WHERE invocation=$1 AND workspace_id=$2",
        [
          input.invocation,
          actor.workspace_id,
          input.amount,
          input.reason,
          input.receipt,
        ],
      );
    });
  }
  async snapshot(workspace: string) {
    return (
      await this.db.pool.query(
        "SELECT scope,period,sum(reserved) AS reserved,sum(charged) AS charged,sum(reserved) FILTER(WHERE category='pending') AS pending FROM cost_reservations WHERE workspace_id=$1 GROUP BY scope,period ORDER BY period DESC",
        [workspace],
      )
    ).rows;
  }
}
