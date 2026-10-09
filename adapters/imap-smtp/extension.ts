/** 标准邮箱连接配置与指纹在适配器内维护，凭据不参与指纹。 */
import { z } from "zod";
import { defineExtension } from "../../packages/extensions/registry.js";
import {
  CommonAccount,
  type MailAdapter,
  type MailContext,
} from "../mail/settings.js";
import { ImapSmtp } from "./index.js";
const Endpoint = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.-]+$/),
    port: z.number().int().min(1).max(65535),
    tls: z.enum(["implicit", "starttls"]),
  })
  .strict();
const Schema = CommonAccount.extend({
  provider: z.literal("imap-smtp"),
  user: z.string().min(1).max(320),
  imap: Endpoint.extend({
    folder: z.string().min(1).max(200).default("INBOX"),
    startFrom: z.enum(["new", "all"]).default("new"),
  }),
  smtp: Endpoint,
}).strict();
export const imapSmtpExtension = defineExtension<
  MailAdapter,
  MailContext,
  typeof Schema
>({
  id: "imap-smtp",
  capabilities: ["receive", "send"],
  schema: Schema,
  identity: (config) => ({
    key: JSON.stringify([
      config.provider,
      config.imap.host.toLowerCase(),
      config.imap.port,
      config.user,
      config.imap.folder,
    ]),
  }),
  references: (config) => [{ kind: "secret", id: config.credential }],
  async diagnose(config, { credentials }, signal) {
    signal.throwIfAborted();
    const secret = await credentials(config.credential);
    if (secret.kind !== "password" && secret.kind !== "oauth2")
      throw new Error("CREDENTIAL_KIND_INVALID");
  },
  create(config, { credentials }) {
    return {
      provider: new ImapSmtp(config, credentials),
      remoteId: config.address,
      identity: [
        config.provider,
        config.address,
        config.user,
        config.imap.host,
        config.imap.port,
        config.imap.tls,
        config.imap.folder,
        config.smtp,
      ],
      physical: JSON.stringify([
        config.provider,
        config.imap.host.toLowerCase(),
        config.imap.port,
        config.user,
        config.imap.folder,
      ]),
    };
  },
});
