/** 邮件兼容装配单独维护，显式注入优先于环境默认值。 */
import { createMailAccount } from "./mail-factory.js";
import { AgentMail } from "../adapters/agentmail/client.js";
import { MailChannel } from "../packages/mail/channel.js";
import { MailStore } from "../packages/mail/store.js";
import type {
  MailSettings,
  MailProvider,
  MailRouter,
} from "../packages/mail/contracts.js";
import type { Config } from "./config.js";
import type { Resources } from "../packages/extensions/registry.js";
import type { Database } from "../packages/persistence/database.js";
import type { IdentityService } from "../packages/identity/service.js";
import type { TaskService } from "../packages/runtime/service.js";
export type MailExtension = {
  settings: MailSettings;
  provider: MailProvider;
  route?: MailRouter;
};
export async function assembleMail(
  config: Config,
  extensions: { mail?: MailExtension; mails?: MailExtension[] },
  db: Database,
  identity: IdentityService,
  service: TaskService,
  resources: Resources,
) {
  const configured = [];
  for (const account of extensions.mails || extensions.mail || config.mail
    ? []
    : (config.mailAccounts ?? [])) {
    if (!config.mailCredentials) throw new Error("MAIL_CREDENTIALS_REQUIRED");
    const adapter = await createMailAccount(account, config.mailCredentials);
    if (adapter.close) resources.add(() => adapter.close!());
    configured.push(adapter);
  }
  const mailOptions: {
    settings: MailSettings;
    provider: MailProvider;
    route?: MailRouter;
  }[] =
    extensions.mails ??
    (extensions.mail
      ? [extensions.mail]
      : config.mail
        ? [
            {
              settings: config.mail,
              provider: new AgentMail(
                config.mail.inbox,
                config.mail.apiKey,
                config.mail.baseUrl,
                config.mail.downloadHosts,
                fetch,
                config.mail,
              ),
            },
          ]
        : configured);
  const mails = mailOptions.map(
    (options) =>
      new MailChannel(
        new MailStore(db, options.settings),
        options.provider,
        identity,
        service,
        options.route,
      ),
  );

  return mails;
}
