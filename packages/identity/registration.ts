import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tokenHash } from "../contracts/fingerprint.js";
import { Problem } from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import { IdentityService } from "./service.js";
/** 仅在可信渠道完成身份验证后调用；初始权限来自迁移账号配置。 */
export class VerifiedIdentities {
  constructor(
    readonly db: Database,
    readonly policy: string,
  ) {}
  async resolve(subject: string) {
    subject = z.email().max(254).parse(subject).toLowerCase();
    const row = (
      await this.db.pool.query<{ workspace_id: string; principal_id: string }>(
        "SELECT workspace_id,principal_id FROM identity_bindings WHERE policy_id=$1 AND subject=$2",
        [this.policy, subject],
      )
    ).rows[0];
    if (!row) throw new Problem(403, "IDENTITY_NOT_REGISTERED");
    return new IdentityService(this.db).current(
      row.workspace_id,
      row.principal_id,
    );
  }
  async enrollVerified(subject: string) {
    subject = z.email().max(254).parse(subject).toLowerCase();
    await this.db.pool.query("SELECT register_verified_identity($1,$2,$3)", [
      this.policy,
      subject,
      tokenHash(randomBytes(32).toString("hex")),
    ]);
    return this.resolve(subject);
  }
}
