/** 可选通道的可信配置；绑定表显式授权邮箱到身份，绝不从来信自动提权。 */
import { fingerprint } from "../packages/persistence/database.js";
import { z } from "zod";
import type { MailSettings } from "../packages/mail/contracts.js";
const Schema = z.object({
  MAIL_MODE: z.enum(["disabled", "agentmail", "accounts"]).default("disabled"),
  AGENTMAIL_INBOX: z.string().default(""),
  AGENTMAIL_API_KEY: z.string().default(""),
  AGENTMAIL_BASE_URL: z.url().default("https://api.agentmail.to/v0"),
  AGENTMAIL_DOWNLOAD_HOSTS: z.string().default("cdn.agentmail.to"),
  AGENTMAIL_RECEIVE_MODE: z.enum(["poll", "webhook"]).default("poll"),
  AGENTMAIL_WEBHOOK_SECRET: z.string().default(""),
  AGENTMAIL_WEBHOOK_TOKEN: z.string().default(""),
  MAIL_WORKSPACE: z.string().min(1).default("default"),
  MAIL_BINDINGS: z.string().default("{}"),
  MAIL_INITIAL_SCAN: z.enum(["process", "skip"]).default("process"),
  MAIL_SEND_ENABLED: z.enum(["false", "true"]).default("false"),
  MAIL_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(5000),
  AGENTMAIL_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(300000),
});
export interface MailConfig extends MailSettings {
  apiKey: string;
  baseUrl: string;
  downloadHosts: string[];
}
export function loadMailConfig(env: NodeJS.ProcessEnv): MailConfig | undefined {
  const value = Schema.parse(env);
  if (value.MAIL_MODE !== "agentmail") return undefined;
  if (
    !value.AGENTMAIL_API_KEY ||
    !value.AGENTMAIL_INBOX ||
    value.AGENTMAIL_INBOX.length > 320
  )
    throw new Error("AGENTMAIL_KEY_AND_INBOX_REQUIRED");
  if (
    value.AGENTMAIL_RECEIVE_MODE === "webhook" &&
    (!value.AGENTMAIL_WEBHOOK_SECRET ||
      value.AGENTMAIL_WEBHOOK_TOKEN.length < 24)
  )
    throw new Error("AGENTMAIL_WEBHOOK_CREDENTIALS_REQUIRED");
  if (
    Boolean(value.AGENTMAIL_WEBHOOK_SECRET) !==
    Boolean(value.AGENTMAIL_WEBHOOK_TOKEN)
  )
    throw new Error("AGENTMAIL_WEBHOOK_CREDENTIALS_REQUIRED");
  if (
    value.AGENTMAIL_WEBHOOK_SECRET &&
    !/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/.test(value.AGENTMAIL_WEBHOOK_SECRET)
  )
    throw new Error("AGENTMAIL_WEBHOOK_SECRET_INVALID");
  let raw: unknown;
  try {
    raw = JSON.parse(value.MAIL_BINDINGS);
  } catch {
    throw new Error("MAIL_BINDINGS_INVALID");
  }
  const bindings = z.record(z.email(), z.string().min(1).max(200)).parse(raw);
  if (!Object.keys(bindings).length) throw new Error("MAIL_BINDINGS_REQUIRED");
  const normalized: Record<string, string> = {};
  for (const [email, principal] of Object.entries(bindings)) {
    const key = email.toLowerCase();
    if (normalized[key] && normalized[key] !== principal)
      throw new Error("MAIL_BINDINGS_CONFLICT");
    normalized[key] = principal;
  }
  return {
    inbox: value.AGENTMAIL_INBOX,
    provider: "agentmail",
    address: value.AGENTMAIL_INBOX,
    accountFingerprint: fingerprint([
      "agentmail",
      value.AGENTMAIL_BASE_URL,
      value.AGENTMAIL_INBOX,
      value.AGENTMAIL_INBOX,
    ]),
    physicalIdentity: JSON.stringify([
      "agentmail",
      value.AGENTMAIL_BASE_URL,
      value.AGENTMAIL_INBOX,
    ]),
    workspace: value.MAIL_WORKSPACE,
    bindings: normalized,
    sendEnabled: value.MAIL_SEND_ENABLED === "true",
    initialScan: value.MAIL_INITIAL_SCAN,
    pollMs:
      value.AGENTMAIL_RECEIVE_MODE === "webhook"
        ? value.AGENTMAIL_RECONCILE_INTERVAL_MS
        : value.MAIL_POLL_INTERVAL_MS,
    webhookSecret: value.AGENTMAIL_WEBHOOK_SECRET,
    webhookToken: value.AGENTMAIL_WEBHOOK_TOKEN,
    apiKey: value.AGENTMAIL_API_KEY,
    baseUrl: value.AGENTMAIL_BASE_URL,
    downloadHosts: value.AGENTMAIL_DOWNLOAD_HOSTS.split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}
