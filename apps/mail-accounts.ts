/** 共用账户验证与供应商自有 Schema 分离；所有错误仅返回脱敏代码。 */
import { z } from "zod";
import {
  CommonAccount,
  type MailAccountConfig,
} from "../adapters/mail/settings.js";
import { mailProviders } from "./extensions.js";
export type { MailAccountConfig } from "../adapters/mail/settings.js";
export function loadMailAccounts(
  env: NodeJS.ProcessEnv,
  providers = mailProviders,
): MailAccountConfig[] {
  if (env.MAIL_MODE !== "accounts") return [];
  try {
    const entries = z
      .array(z.unknown())
      .min(1)
      .max(20)
      .parse(JSON.parse(env.MAIL_ACCOUNTS ?? ""));
    const ids = new Set<string>(),
      physical = new Set<string>(),
      credentials = new Set<string>();
    return entries.map((raw) => {
      const common = CommonAccount.parse(raw);
      const options = providers.parse(common.provider, raw);
      if (ids.has(common.id)) throw new Error("MAIL_ACCOUNT_ID_CONFLICT");
      const identity = providers.identity(common.provider, options);
      if (identity && physical.has(identity.key))
        throw new Error("MAIL_ACCOUNT_ID_CONFLICT");
      if (identity?.exclusiveCredential && credentials.has(common.credential))
        throw new Error("MAIL_CREDENTIAL_REFERENCE_CONFLICT");
      if (identity) physical.add(identity.key);
      if (identity?.exclusiveCredential) credentials.add(common.credential);
      ids.add(common.id);
      const bindings: Record<string, string> = {};
      for (const [email, id] of Object.entries(common.bindings)) {
        const key = email.toLowerCase();
        if (bindings[key] && bindings[key] !== id)
          throw new Error("MAIL_BINDINGS_CONFLICT");
        bindings[key] = id;
      }
      if (!Object.keys(bindings).length)
        throw new Error("MAIL_BINDINGS_REQUIRED");
      return {
        ...common,
        address: common.address.toLowerCase(),
        bindings,
        options,
      };
    });
  } catch (error) {
    if (error instanceof Error && /^MAIL_[A-Z_]+$/.test(error.message))
      throw error;
    throw new Error("MAIL_ACCOUNTS_INVALID");
  }
}
