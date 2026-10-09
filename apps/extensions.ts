/** 唯一静态扩展清单：新增实现只需导入并注册；不动态加载用户代码。 */
import { ExtensionRegistry } from "../packages/extensions/registry.js";
import { agentMailExtension } from "../adapters/agentmail/extension.js";
import { imapSmtpExtension } from "../adapters/imap-smtp/extension.js";
import type { MailAdapter, MailContext } from "../adapters/mail/settings.js";
export const mailProviders = new ExtensionRegistry<MailAdapter, MailContext>([
  agentMailExtension,
  imapSmtpExtension,
]);

import { modelProviders } from "./models.js";
import { artifactProviders } from "./artifacts.js";

import { channelProviders } from "./channel-config.js";
export { modelProviders, artifactProviders, channelProviders };
