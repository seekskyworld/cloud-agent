/** 认证方式与管理角色分离；每次认证及任务恢复均读取当前角色和业务能力。 */
import type { Database } from "../persistence/database.js";
import { tokenHash } from "../contracts/fingerprint.js";
import { Problem, type Principal } from "../contracts/index.js";
export class IdentityService {
  constructor(private db: Database) {}
  async authenticate(token: string): Promise<Principal> {
    const row = (
      await this.db.pool.query<Principal>(
        "SELECT id,workspace_id,capabilities,enabled,role FROM principals WHERE enabled AND (token_hash=$1 OR EXISTS(SELECT 1 FROM principal_tokens t WHERE t.workspace_id=principals.workspace_id AND t.principal_id=principals.id AND t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()))",
        [tokenHash(token)],
      )
    ).rows[0];
    if (!row) throw new Problem(401, "INVALID_TOKEN");
    return row;
  }
  async current(workspace: string, id: string): Promise<Principal> {
    const row = (
      await this.db.pool.query<Principal>(
        "SELECT id,workspace_id,capabilities,enabled,role FROM principals WHERE workspace_id=$1 AND id=$2 AND enabled",
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new Problem(403, "IDENTITY_REVOKED");
    return row;
  }
}
