/** 密码或短期 OAuth2 令牌单独提供；只读文件允许外部凭据服务原子轮换。 */
import { environmentSecrets } from "../adapters/credentials/environment.js";
import { z } from "zod";
import { MailProviderError } from "../packages/mail/contracts.js";
const Value = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("password"), password: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("oauth2"),
      accessToken: z.string().min(1),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("api-key"),
      apiKey: z.string().min(1),
      webhookSecret: z
        .string()
        .regex(/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/)
        .optional(),
      webhookToken: z.string().min(24).optional(),
      webhookId: z.string().min(1).optional(),
      webhookUrl: z.url().optional(),
    })
    .strict(),
]);
import type { MailCredentials } from "../packages/mail/contracts.js";
export type { MailCredentials } from "../packages/mail/contracts.js";
export function createMailCredentials(env: NodeJS.ProcessEnv): MailCredentials {
  const dedicated = !!(env.MAIL_CREDENTIALS || env.MAIL_CREDENTIALS_FILE);
  const secrets = environmentSecrets(
    dedicated
      ? {
          json: env.MAIL_CREDENTIALS || undefined,
          file: env.MAIL_CREDENTIALS_FILE || undefined,
        }
      : {
          json: env.CONNECTION_CREDENTIALS || undefined,
          file: env.CONNECTION_CREDENTIALS_FILE || undefined,
        },
  );
  return async (name) => {
    try {
      const value = Value.parse(await secrets(name));
      if (!value) throw new Error("missing");
      if (
        value.kind === "oauth2" &&
        Date.parse(value.expiresAt) <= Date.now() + 30_000
      )
        throw new Error("expired");
      if (
        value.kind === "api-key" &&
        Boolean(value.webhookSecret) !== Boolean(value.webhookToken)
      )
        throw new Error("webhook");
      return value;
    } catch {
      throw new MailProviderError(401, "MAIL_CREDENTIAL_UNAVAILABLE");
    }
  };
}
