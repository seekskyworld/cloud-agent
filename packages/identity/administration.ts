/** 通用管理面只授权工作区内身份管理；业务数据与工具继续按显式能力和领域 ACL 授权。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Problem, type Principal, type Role } from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import { tokenHash } from "../contracts/fingerprint.js";
import type { IdentityService } from "./service.js";

export const roleDefinitions = [
  { id: "member", label: "成员", permissions: [] },
  {
    id: "admin",
    label: "管理员",
    permissions: ["identity:read", "audit:read"],
  },
  {
    id: "superadmin",
    label: "超级管理员",
    permissions: ["identity:read", "audit:read", "identity:manage"],
  },
] as const;
export function administrationPermissions(role: Role): readonly string[] {
  return roleDefinitions.find((entry) => entry.id === role)!.permissions;
}
import { AccessChange } from "../contracts/administration.js";
export type ManagedPrincipal = Principal & { access_version: number };
const databaseErrors: Record<string, number> = {
  SUPERADMIN_REQUIRED: 403,
  SUPERADMIN_PROTECTED: 403,
  INVALID_ACCESS_CHANGE: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ACCESS_VERSION_CONFLICT: 409,
  PRINCIPAL_NOT_FOUND: 404,
};
export class AdministrationService {
  constructor(
    private db: Database,
    private identity: IdentityService,
    private capabilities: () => string[],
  ) {}
  private async authorize(actor: Principal, permission: string) {
    const current = await this.identity.current(actor.workspace_id, actor.id);
    if (!administrationPermissions(current.role).includes(permission))
      throw new Problem(403, "ADMINISTRATION_FORBIDDEN");
    return current;
  }
  async catalog(actor: Principal) {
    await this.authorize(actor, "identity:read");
    return { roles: roleDefinitions, capabilities: this.capabilities() };
  }
  async members(actor: Principal, offset = 0): Promise<ManagedPrincipal[]> {
    await this.authorize(actor, "identity:read");
    return (
      await this.db.pool.query<ManagedPrincipal>(
        "SELECT id,workspace_id,role,capabilities,enabled,access_version FROM principals WHERE workspace_id=$1 ORDER BY id LIMIT 100 OFFSET $2",
        [actor.workspace_id, offset],
      )
    ).rows;
  }
  async audit(actor: Principal, before?: number) {
    await this.authorize(actor, "audit:read");
    return (
      await this.db.pool.query(
        "SELECT id,actor_id,target_id,action,reason,before_access,after_access,created_at FROM administration_audit WHERE workspace_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 100",
        [actor.workspace_id, before ?? null],
      )
    ).rows;
  }
  /** expectedVersion=null 只允许新建；编辑必须携带读到的版本，重复请求只返回原结果。 */
  async change(
    actor: Principal,
    input: unknown,
    requestKey: string,
  ): Promise<ManagedPrincipal> {
    await this.authorize(actor, "identity:manage");
    const body = AccessChange.parse(input);
    const key = z.string().min(1).max(180).parse(requestKey);
    const allowed = new Set(this.capabilities());
    if (body.capabilities.some((capability) => !allowed.has(capability)))
      throw new Problem(400, "UNKNOWN_CAPABILITY");
    const capabilities = [...new Set(body.capabilities)].sort();
    try {
      return (
        await this.db.pool.query<{ result: ManagedPrincipal }>(
          "SELECT manage_principal_access($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
          [
            actor.workspace_id,
            actor.id,
            body.id,
            body.role,
            capabilities,
            body.enabled,
            body.expectedVersion,
            body.reason,
            key,
            tokenHash(randomBytes(32).toString("hex")),
          ],
        )
      ).rows[0]!.result;
    } catch (error) {
      if (error instanceof Error && databaseErrors[error.message])
        throw new Problem(databaseErrors[error.message]!, error.message);
      throw error;
    }
  }
}
