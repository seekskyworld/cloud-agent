/** 邮件供应商端口：身份认证由适配器核验，业务路由由宿主注入。 */
import { DeliveryError } from "../channels/delivery.js";
import type { Data, Principal } from "../contracts/index.js";
export interface MailMessage {
  id: string;
  threadId: string;
  sender: string;
  authenticated: boolean;
  automatic: boolean;
  subject: string;
  text: string;
  inReplyTo?: string;
  /** RFC Message-ID，与供应商定位 ID 分离。 */
  messageId?: string;
  deduplicationId?: string;
}
export interface MailDelivery {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  replyTo: string;
  /** 缺省保持旧任务回复语义；服务请求不伪装成人工邮件。 */
  purpose?: "reply" | "notification" | "service-request";
}
export interface MailPage {
  ids: string[];
  cursor: string | null;
  hasMore?: boolean;
}
export interface MailWebhookEvent {
  id: string;
  messageId: string;
  digest: string;
}
export interface MailProvider {
  verifyWebhook?(
    raw: Buffer,
    headers: Record<string, unknown>,
  ): MailWebhookEvent | Promise<MailWebhookEvent>;
  list(cursor: string | null, signal: AbortSignal): Promise<MailPage>;
  read(id: string, signal: AbortSignal): Promise<MailMessage>;
  send(delivery: MailDelivery, signal: AbortSignal): Promise<string>;
}
export interface MailSettings {
  /** 省略 id 时沿用旧 inbox 主键；新配置必须显式指定稳定 ID。 */
  id?: string;
  provider?: string;
  address?: string;
  accountFingerprint?: string;
  /** 可信适配器提供物理邮箱标识，用于发现重复消费者；不含凭据。 */
  physicalIdentity?: string;
  inbox: string;
  workspace: string;
  bindings: Record<string, string>;
  sendEnabled: boolean;
  pollMs: number;
  /** 仅作用于新账户第一次完整扫描；省略保持原先处理行为。 */
  initialScan?: "process" | "skip";
  webhookSecret?: string;
  webhookToken?: string;
}
export type MailRouter = (
  message: MailMessage,
  principal: Principal,
) => { moduleId: string; input: Data };
/** 只传播脱敏状态码；未知发送故障不能被适配器伪装成可重试错误。 */
export class MailProviderError extends DeliveryError {
  constructor(
    readonly status: number,
    code = `MAIL_HTTP_${status}`,
  ) {
    super(code, [400, 401, 403, 404, 422, 429].includes(status));
  }
}

/** 凭据供应器可由宿主替换；秘密不进入邮件表或任务输入。 */
export type MailCredential =
  | { kind: "password"; password: string }
  | { kind: "oauth2"; accessToken: string; expiresAt: string }
  | {
      kind: "api-key";
      apiKey: string;
      webhookSecret?: string;
      webhookToken?: string;
    };
export type MailCredentials = (name: string) => Promise<MailCredential>;
