/** 装配只依赖注册协议，不按供应商品牌选择分支。 */
import { fingerprint } from "../packages/persistence/database.js";
import type {
  MailCredentials,
  MailSettings,
} from "../packages/mail/contracts.js";
import type { MailAccountConfig } from "./mail-accounts.js";
import { mailProviders } from "./extensions.js";
export async function createMailAccount(
  config: MailAccountConfig,
  credentials: MailCredentials,
  providers = mailProviders,
) {
  const { options, ...common } = config;
  const adapter = await providers.create(
    config.provider,
    { ...(options as object), ...common },
    { credentials },
  );
  const settings: MailSettings = {
    id: config.id,
    provider: config.provider,
    address: config.address,
    inbox: adapter.remoteId,
    workspace: config.workspace,
    bindings: config.bindings,
    sendEnabled: config.sendEnabled,
    pollMs: config.pollMs,
    accountFingerprint: fingerprint(adapter.identity),
  };
  return { settings, ...adapter };
}
