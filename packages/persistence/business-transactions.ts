/** 业务工具与框架共享短事务；禁止在回调内访问网络。 */
import { ExecutionFailure } from "../contracts/failure.js";
import type { PoolClient } from "pg";
import {
  Problem,
  requireCapability,
  type ExecutionContext,
  type Principal,
} from "../contracts/index.js";
import type { Database } from "./database.js";
export class BusinessTransactions {
  constructor(private db: Database) {}
  async run<T>(
    context: ExecutionContext,
    capability: string,
    action: (client: PoolClient, principal: Principal) => Promise<T>,
  ): Promise<T> {
    context.signal.throwIfAborted();
    let rejected: Problem | undefined;
    try {
      try {
        requireCapability(context.principal, capability);
      } catch (error) {
        if (error instanceof Problem) rejected = error;
        throw error;
      }
      return await this.db.transaction(async (client) => {
        try {
          if (
            (
              await client.query<{ enabled: boolean }>(
                "SELECT public.runtime_maintenance_enabled() AS enabled",
              )
            ).rows[0]?.enabled
          )
            throw new Problem(503, "MAINTENANCE_ENABLED");
          const principal = (
            await client.query<Principal>(
              "SELECT * FROM public.runtime_lock_principals($1,ARRAY[$2])",
              [context.principal.workspace_id, context.principal.id],
            )
          ).rows[0];
          if (!principal) throw new Problem(403, "IDENTITY_REVOKED");
          requireCapability(principal, capability);
          // run 绑定本轮租约；持锁到业务提交，旧 Worker 不能写入新结果。
          const task = await client.query(
            `SELECT t.id FROM public.tasks t JOIN public.runs r ON r.task_id=t.id AND r.lease_token=t.lease_token
         JOIN public.steps s ON s.task_id=t.id AND s.id=$3
         WHERE t.id=$1 AND r.id=$2 AND r.status='running' AND t.status='running'
         AND t.lease_until>now() AND t.workspace_id=$4 AND t.principal_id=$5 FOR UPDATE OF t`,
            [
              context.taskId,
              context.runId,
              context.invocationId,
              principal.workspace_id,
              principal.id,
            ],
          );
          if (!task.rowCount) throw new Problem(409, "LEASE_LOST");
          const result = await action(client, {
            ...principal,
            capabilities: principal.capabilities.filter((c) =>
              context.principal.capabilities.includes(c),
            ),
          });
          context.signal.throwIfAborted();
          const valid = await client.query(
            "SELECT 1 FROM public.tasks WHERE id=$1 AND lease_until>clock_timestamp()",
            [context.taskId],
          );
          if (!valid.rowCount) throw new Problem(409, "LEASE_LOST");
          return result;
        } catch (error) {
          if (error instanceof Problem) rejected = error;
          throw error;
        }
      });
    } catch (error) {
      // 只有业务回调拒绝且数据库成功回滚，才能证明此次没有提交；COMMIT 失联仍未知。
      if (rejected && error === rejected)
        throw new ExecutionFailure(
          [401, 403].includes(rejected.status)
            ? "authorization"
            : rejected.status === 429
              ? "rate_limited"
              : rejected.status < 500
                ? "permanent"
                : "transient",
          rejected.code,
          { notAccepted: true },
        );
      throw error;
    }
  }
}
