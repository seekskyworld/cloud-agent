import type { PoolClient } from "pg";
/** 附加令牌有独立撤销和期限；不复制角色或能力，服务身份使用独立平台主体。 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../persistence/database.js";
import { tokenHash } from "../contracts/fingerprint.js";
import { Problem, type Principal } from "../contracts/index.js";
export class PrincipalTokens {
  constructor(private db: Database) {}
  async create(
    actor: Principal,
    name: string,
    days: number,
    client: Pick<PoolClient, "query"> = this.db.pool,
  ) {
    if (
      !actor.enabled ||
      !name.trim() ||
      name.length > 100 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    )
      throw new Problem(400, "TOKEN_REQUEST_INVALID");
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID();
    const row = (
      await client.query(
        "WITH created AS (INSERT INTO principal_tokens(id,workspace_id,principal_id,token_hash,name,expires_at) SELECT $1,$2,$3,$4,$5,now()+$6::integer*interval '1 day' WHERE EXISTS(SELECT 1 FROM principals WHERE workspace_id=$2 AND id=$3 AND enabled) RETURNING id,name,expires_at), audit AS (INSERT INTO token_audit(workspace_id,principal_id,token_id,action) SELECT $2,$3,id,'create' FROM created) SELECT * FROM created",
        [id, actor.workspace_id, actor.id, tokenHash(token), name, days],
      )
    ).rows[0];
    if (!row) throw new Problem(403, "IDENTITY_REVOKED");
    return { ...row, token };
  }
  async list(actor: Principal) {
    return (
      await this.db.pool.query(
        "SELECT id,name,expires_at,revoked_at FROM principal_tokens WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC",
        [actor.workspace_id, actor.id],
      )
    ).rows;
  }
  async revoke(actor: Principal, id: string) {
    const result = await this.db.pool.query(
      "WITH revoked AS (UPDATE principal_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 AND EXISTS(SELECT 1 FROM principals WHERE workspace_id=$2 AND id=$3 AND enabled) RETURNING id) INSERT INTO token_audit(workspace_id,principal_id,token_id,action) SELECT $2,$3,id,'revoke' FROM revoked",
      [id, actor.workspace_id, actor.id],
    );
    if (!result.rowCount) throw new Problem(404, "TOKEN_NOT_FOUND");
  }
}
