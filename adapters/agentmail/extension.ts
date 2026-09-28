/** AgentMail 自行拥有配置、身份指纹及客户端创建；核心不检查品牌。 */
import { z } from "zod";
import { defineExtension } from "../../packages/extensions/registry.js";
import {
  CommonAccount,
  type MailAdapter,
  type MailContext,
} from "../mail/settings.js";
import { AgentMail } from "./client.js";
import { MailProviderError } from "../../packages/mail/contracts.js";
export const AgentMailAccount = CommonAccount.extend({
  provider: z.literal("agentmail"),
  inbox: z.string().min(1).max(320),
  baseUrl: z.url().default("https://api.agentmail.to/v0"),
  downloadHosts: z
    .array(z.string().min(1))
    .min(1)
    .default(["cdn.agentmail.to"]),
}).strict();
export const agentMailExtension = defineExtension<
  MailAdapter,
  MailContext,
  typeof AgentMailAccount
>({
  id: "agentmail",
  capabilities: ["receive", "send", "webhook"],
  schema: AgentMailAccount,
  identity: (config) => ({
    key: JSON.stringify([config.provider, config.baseUrl, config.inbox]),
    exclusiveCredential: true,
  }),
  references: (config) => [{ kind: "secret", id: config.credential }],
  async diagnose(config, { credentials }, signal) {
    signal.throwIfAborted();
    const secret = await credentials(config.credential);
    if (secret.kind !== "api-key") throw new Error("CREDENTIAL_KIND_INVALID");
  },
  create(config, { credentials }) {
    const client = async () => {
      const secret = await credentials(config.credential);
      if (secret.kind !== "api-key")
        throw new MailProviderError(401, "MAIL_CREDENTIAL_KIND");
      return new AgentMail(
        config.inbox,
        secret.apiKey,
        config.baseUrl,
        config.downloadHosts,
        fetch,
        {
          ...config,
          inbox: config.inbox,
          webhookSecret: secret.webhookSecret,
          webhookToken: secret.webhookToken,
        },
      );
    };
    return {
      remoteId: config.inbox,
      identity: [config.provider, config.baseUrl, config.inbox, config.address],
      physical: JSON.stringify([config.provider, config.baseUrl, config.inbox]),
      exclusiveCredential: true,
      provider: {
        list: async (c, s) => (await client()).list(c, s),
        read: async (i, s) => (await client()).read(i, s),
        send: async (d, s) => (await client()).send(d, s),
        verifyWebhook: async (r, h) => (await client()).verifyWebhook(r, h),
      },
    };
  },
});
