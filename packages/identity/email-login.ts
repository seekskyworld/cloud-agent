import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { Problem } from "../contracts/index.js";
import { tokenHash } from "../contracts/fingerprint.js";
import type { Database } from "../persistence/database.js";
import type { SystemMail, SystemMailPolicy } from "../mail/system.js";
import { PrincipalTokens } from "./tokens.js";
import { VerifiedIdentities } from "./registration.js";
export interface EmailLoginOptions {
  policy: string;
  secret: string;
  origin: string;
  name: string;
}
/** 验证码仅加密保留；会话使用既有 principal_tokens，角色仍实时读取。 */
export class EmailLogin {
  readonly identities: VerifiedIdentities;
  constructor(
    private db: Database,
    readonly options: EmailLoginOptions,
    private mail?: SystemMail,
  ) {
    if (options.secret.length < 32) throw new Error("LOGIN_SECRET_REQUIRED");
    this.identities = new VerifiedIdentities(db, options.policy);
  }
  bind(mail: SystemMail) {
    this.mail = mail;
  }
  policy(): SystemMailPolicy {
    return {
      id: `login:${this.options.policy}`,
      version: "1",
      prepare: async (input) => {
        const row = (
          await this.db.pool.query<{ sealed_code: string }>(
            "SELECT sealed_code FROM identity_email_challenges WHERE id=$1 AND policy_id=$2 AND email=$3 AND NOT used AND attempts<5 AND expires_at>now()",
            [input.metadata.challenge, this.options.policy, input.recipient],
          )
        ).rows[0];
        if (!row) throw new Problem(409, "LOGIN_CHALLENGE_EXPIRED");
        const code = this.open(
          row.sealed_code,
          String(input.metadata.challenge),
        );
        return {
          subject: `${this.options.name} · 登录验证码`,
          body: `验证码：${code}\n10 分钟内有效，仅使用一次，请勿转发。\n登录站点：${this.options.origin}\n若非本人操作请忽略。`,
        };
      },
    };
  }
  async request(email: string, ip: string) {
    email = z.email().max(254).parse(email).toLowerCase();
    if (!this.mail) throw new Problem(503, "LOGIN_UNAVAILABLE");
    return this.db.transaction(async (c) => {
      const ipHash = this.digest(ip),
        id = randomUUID(),
        code = String(randomInt(1000000)).padStart(6, "0");
      for (const key of [`email:${email}`, `ip:${ipHash}`].sort())
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `login:${this.options.policy}:${key}`,
        ]);
      const n = (
        await c.query<{ emails: string; ips: string; recent: string }>(
          "SELECT count(*) FILTER(WHERE email=$2) AS emails,count(*) FILTER(WHERE ip_hash=$3) AS ips,count(*) FILTER(WHERE email=$2 AND created_at>now()-interval '60 seconds') AS recent FROM identity_email_challenges WHERE policy_id=$1 AND created_at>now()-interval '1 hour'",
          [this.options.policy, email, ipHash],
        )
      ).rows[0]!;
      if (Number(n.emails) >= 5 || Number(n.ips) >= 20 || Number(n.recent) > 0)
        throw new Problem(429, "LOGIN_RATE_LIMIT");
      await c.query(
        "UPDATE identity_email_challenges SET used=true,sealed_code='' WHERE policy_id=$1 AND email=$2 AND NOT used",
        [this.options.policy, email],
      );
      await c.query(
        "INSERT INTO identity_email_challenges(id,policy_id,email,ip_hash,code_hash,sealed_code) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          this.options.policy,
          email,
          ipHash,
          this.digest(id + ":" + code),
          this.seal(code, id),
        ],
      );
      await this.mail!.enqueue(c, `login:${this.options.policy}`, {
        key: id,
        recipient: email,
        subject: this.options.name + " · 登录",
        body: "验证码仅在发送前解密",
        metadata: { challenge: id },
      });
      await c.query(
        "UPDATE identity_email_challenges SET sealed_code='',code_hash='' WHERE expires_at<now() AND sealed_code<>''",
      );
      return { id, message: "验证码已加入发送队列，请稍候查收邮箱。" };
    });
  }
  async verify(id: string, code: string) {
    z.uuid().parse(id);
    z.string()
      .regex(/^\d{6}$/)
      .parse(code);
    const result = await this.db.transaction(async (c) => {
      if (
        (
          await c.query<{ enabled: boolean }>(
            "SELECT public.runtime_maintenance_enabled() AS enabled",
          )
        ).rows[0]?.enabled
      )
        throw new Problem(503, "MAINTENANCE_ENABLED");
      const row = (
        await c.query<{
          email: string;
          code_hash: string;
          attempts: number;
          used: boolean;
          valid: boolean;
        }>(
          "SELECT *,expires_at>now() AS valid FROM identity_email_challenges WHERE id=$1 AND policy_id=$2 FOR UPDATE",
          [id, this.options.policy],
        )
      ).rows[0];
      if (!row || row.used || !row.valid || row.attempts >= 5) return null;
      if (
        !timingSafeEqual(
          Buffer.from(row.code_hash, "hex"),
          Buffer.from(this.digest(id + ":" + code), "hex"),
        )
      ) {
        await c.query(
          "UPDATE identity_email_challenges SET attempts=attempts+1 WHERE id=$1",
          [id],
        );
        return null;
      }
      const principal = await this.identities.enrollVerified(row.email);
      const token = await new PrincipalTokens(this.db).create(
        principal,
        "browser",
        30,
        c,
      );
      await c.query(
        "UPDATE identity_email_challenges SET used=true,sealed_code='',code_hash='' WHERE id=$1",
        [id],
      );
      return token.token;
    });
    if (!result) throw new Problem(401, "LOGIN_CODE_INVALID");
    return result;
  }
  async logout(token: string) {
    await this.db.pool.query(
      "WITH revoked AS (UPDATE principal_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE token_hash=$1 RETURNING *) INSERT INTO token_audit(workspace_id,principal_id,token_id,action) SELECT workspace_id,principal_id,id,'revoke' FROM revoked",
      [tokenHash(token)],
    );
  }
  private digest(value: string) {
    return createHmac("sha256", this.options.secret)
      .update(value)
      .digest("hex");
  }
  private seal(value: string, challenge: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        createHash("sha256").update(this.options.secret).digest(),
        iv,
      );
    cipher.setAAD(Buffer.from(this.options.policy + ":" + challenge));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  private open(value: string, challenge: string) {
    const b = Buffer.from(value, "base64"),
      d = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256").update(this.options.secret).digest(),
        b.subarray(0, 12),
      );
    d.setAAD(Buffer.from(this.options.policy + ":" + challenge));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(
      "utf8",
    );
  }
}
