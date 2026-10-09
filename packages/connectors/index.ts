/** 连接器作者的稳定入口；不暴露任务存储、宿主容器或具体供应商。 */
export { CommonAccount } from "./mail.js";
export type {
  AccountCommon,
  MailAccountConfig,
  MailAdapter,
  MailContext,
} from "./mail.js";
export { defineExtension, ExtensionRegistry } from "../extensions/registry.js";
export type {
  Extension,
  Diagnostic,
  ExtensionReference,
} from "../extensions/registry.js";
export {
  MailProviderError,
  canReceive,
  canSend,
  mailCapabilities,
} from "../mail/contracts.js";
export type {
  MailProvider,
  MailTransport,
  MailSender,
  MailReceiver,
  MailMessage,
  MailDelivery,
  MailPage,
  MailWebhookEvent,
  MailCredentials,
  MailCredential,
  MailSettings,
  MailRouter,
} from "../mail/contracts.js";
export type {
  ModelEngine,
  ModelRequest,
  ModelTurn,
} from "../contracts/index.js";

export type { ArtifactStore } from "./artifacts.js";
export { ChannelMessage } from "./channel.js";
export type { ChannelProvider, ChannelSettings } from "./channel.js";
export type { ContextProvider, ContextDocument } from "../contracts/context.js";

export type {
  ResourceDescriptor,
  ResourceRole,
} from "../extensions/inventory.js";
