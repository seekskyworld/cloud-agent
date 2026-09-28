/** 可信宿主注册业务协议；正文不能指定策略、操作者或目标任务。 */
import type { Data, Principal } from "../contracts/index.js";
import type { MailMessage } from "./contracts.js";
export interface BusinessMailInput {
  key: string;
  recipient: string;
  subject: string;
  body: string;
  replyTo?: string;
  purpose: "reply" | "notification" | "service-request";
  waitKey?: string;
  metadata: Data;
}
export interface BusinessMailPolicy {
  id: string;
  version: string;
  capability: string;
  /** 入队及发送前均调用；必须验证收件人、用途和领域当前权限。只读，不执行外部写入。 */
  authorize(
    input: BusinessMailInput,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<void>;
  receipt?: {
    sender: string;
    /** 已存在的服务主体，须有 task:signal 及策略能力；不是任务所有者。 */
    principal: string;
    /** 严格解析业务协议。返回的 key 仅用于查找已持久化请求，不授予任务访问权。 */
    parse(message: MailMessage): { key: string; response: Data };
    validate(response: Data, request: BusinessMailInput): void;
  };
}
