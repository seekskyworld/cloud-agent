/** 兼容旧宿主路径；新连接器使用公共 connectors 入口。 */
export { CommonAccount } from "../../packages/connectors/mail.js";
export type {
  AccountCommon,
  MailAccountConfig,
  MailAdapter,
  MailContext,
} from "../../packages/connectors/mail.js";
