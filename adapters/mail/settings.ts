/** 邮件供应商配置只描述协议连接；共用账户字段由应用层验证。 */
import { z } from "zod";
import type {
  MailCredentials,
  MailProvider,
} from "../../packages/mail/contracts.js";
export const CommonAccount = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_@.+-]{0,319}$/),
  provider: z.string().min(1),
  address: z.email(),
  workspace: z.string().min(1).max(200),
  bindings: z.record(z.email(), z.string().min(1).max(200)),
  credential: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  sendEnabled: z.boolean().default(false),
  initialScan: z.enum(["process", "skip"]).optional(),
  pollMs: z.number().int().min(1000).max(3600000).default(5000),
});
export type AccountCommon = z.infer<typeof CommonAccount>;
export type MailAccountConfig = AccountCommon & { options: unknown };
export interface MailAdapter {
  provider: MailProvider;
  remoteId: string;
  identity: unknown;
  physical: string;
  exclusiveCredential?: boolean;
  close?: () => Promise<void>;
}
export type MailContext = { credentials: MailCredentials };
