/** 各渠道自持配置 Schema；公共配置只描述身份与任务路由。 */
import { z } from "zod";
import {
  ExtensionRegistry,
  defineExtension,
} from "../packages/extensions/registry.js";
import type { ChannelProvider } from "../packages/channels/channel.js";
import type { SecretProvider } from "../packages/connections/index.js";
import { SignedWebhook } from "../adapters/webhook/index.js";
export const ChannelAccount = z.object({
  provider: z.string().min(1).default("webhook"),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  workspace: z.string().min(1),
  bindings: z.record(z.string().min(1), z.string().min(1)),
  moduleId: z.string().min(1),
  sendEnabled: z.boolean().default(false),
});
export const WebhookAccount = ChannelAccount.extend({
  provider: z.literal("webhook").default("webhook"),
  credential: z.string().min(1),
  url: z
    .url()
    .refine((value) => {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash;
    })
    .optional(),
})
  .strict()
  .refine((c) => !c.sendEnabled || !!c.url);
export const channelProviders = new ExtensionRegistry<
  ChannelProvider,
  SecretProvider
>([
  defineExtension<ChannelProvider, SecretProvider, typeof WebhookAccount>({
    id: "webhook",
    capabilities: ["verify", "send"],
    schema: WebhookAccount,
    identity: (c) => ({ key: JSON.stringify([c.credential, c.url ?? null]) }),
    references: (c) => [{ kind: "secret", id: c.credential }],
    async diagnose(c, secrets, signal) {
      const secret = await secrets(c.credential, signal);
      if (
        typeof secret.signingKey !== "string" ||
        secret.signingKey.length < 32
      )
        throw new Error("CREDENTIAL_INVALID");
    },
    create: (c, secrets) => new SignedWebhook(c, secrets),
  }),
]);
export type ChannelAccountConfig = z.infer<typeof ChannelAccount> & {
  options: unknown;
};
export function loadChannels(raw: string | undefined): ChannelAccountConfig[] {
  try {
    const values = z
      .array(ChannelAccount.passthrough())
      .max(20)
      .parse(JSON.parse(raw || "[]"));
    if (
      new Set(values.map((c) => c.id)).size !== values.length ||
      values.some((c) => !Object.keys(c.bindings).length)
    )
      throw new Error("invalid");
    return values.map((c) => ({
      ...ChannelAccount.parse(c),
      options: channelProviders.parse(c.provider, c),
    }));
  } catch {
    throw new Error("CHANNEL_CONFIG_INVALID");
  }
}
