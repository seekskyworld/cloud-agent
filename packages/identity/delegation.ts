import type { PoolClient } from "pg";
/** 委托只授予某个任务的读取/审批动作；不转移任务所有权或生成业务通配权限。 */
import { randomUUID } from "node:crypto";
import { Problem, type Principal } from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
export interface PolicyPort {
  authorize(
    actor: Principal,
    resource: { taskId: string; ownerId: string },
    action: "read" | "approve",
  ): Promise<Principal>;
}
export class Delegations implements PolicyPort {
  constructor(private db: Database) {}
  async grant(
    actor: Principal,
    taskId: string,
    delegate: string,
    actions: ("read" | "approve")[],
    hours: number,
    reason: string,
  ) {
    if (
      !actions.length ||
      actions.some((a) => !["read", "approve"].includes(a)) ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 168 ||
      !reason.trim()
    )
      throw new Problem(400, "DELEGATION_INVALID");
    return this.db.transaction(async (client) => {
      const task = await client.query(
        "SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 FOR SHARE",
        [taskId, actor.workspace_id, actor.id],
      );
      const users = await client.query(
        "SELECT id FROM runtime_lock_principals($1,$2) WHERE enabled",
        [actor.workspace_id, [actor.id, delegate]],
      );
      if (!task.rowCount || delegate === actor.id || users.rowCount !== 2)
        throw new Problem(403, "DELEGATION_FORBIDDEN");
      const id = randomUUID();
      await client.query(
        "INSERT INTO delegations(id,workspace_id,owner_id,delegate_id,task_id,actions,expires_at,reason) VALUES($1,$2,$3,$4,$5,$6,now()+$7::integer*interval '1 hour',$8)",
        [
          id,
          actor.workspace_id,
          actor.id,
          delegate,
          taskId,
          actions,
          hours,
          reason,
        ],
      );
      await client.query(
        "INSERT INTO delegation_audit(delegation_id,actor,action) VALUES($1,$2,'granted')",
        [id, actor.id],
      );
      return { id };
    });
  }
  async revoke(actor: Principal, id: string) {
    await this.db.transaction(async (client) => {
      const row = await client.query(
        "UPDATE delegations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 RETURNING id",
        [id, actor.workspace_id, actor.id],
      );
      if (!row.rowCount) throw new Problem(404, "DELEGATION_NOT_FOUND");
      await client.query(
        "INSERT INTO delegation_audit(delegation_id,actor,action) VALUES($1,$2,'revoked')",
        [id, actor.id],
      );
    });
  }
  async authorize(
    actor: Principal,
    resource: { taskId: string; ownerId: string },
    action: "read" | "approve",
  ) {
    return authorizeDelegation(this.db.pool, actor, resource, action);
  }
}

export async function authorizeDelegation(
  client: Pick<PoolClient, "query">,
  actor: Principal,
  resource: { taskId: string; ownerId: string },
  action: "read" | "approve",
) {
  const grant = (
    await client.query(
      "SELECT id FROM delegations WHERE workspace_id=$1 AND owner_id=$2 AND delegate_id=$3 AND task_id=$4 AND $5=ANY(actions) AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
      [actor.workspace_id, resource.ownerId, actor.id, resource.taskId, action],
    )
  ).rows[0];
  if (!grant) throw new Problem(403, "DELEGATION_FORBIDDEN");
  const users = (
    await client.query<Principal>(
      "SELECT * FROM runtime_lock_principals($1,$2) WHERE enabled",
      [actor.workspace_id, [actor.id, resource.ownerId]],
    )
  ).rows;
  const owner = users.find((u) => u.id === resource.ownerId),
    delegate = users.find((u) => u.id === actor.id);
  if (!owner || !delegate) throw new Problem(403, "IDENTITY_REVOKED");
  // 使用双方当前能力交集，委托不能绕过所有者或受托人的撤权。
  return {
    ...owner,
    capabilities: owner.capabilities.filter((c) =>
      delegate.capabilities.includes(c),
    ),
  };
}
