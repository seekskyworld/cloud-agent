import type { Data, Principal } from "../contracts/index.js";
import type { TaskService } from "../runtime/service.js";
import type { MailMessage } from "./contracts.js";
export type MailNotice = NonNullable<
  Awaited<ReturnType<TaskService["notification"]>>
>;
/** 仅可信宿主注入；鉴权、绑定等待及投递仍由通道执行。 */
export interface MailHooks {
  systemPolicies?: readonly import("./system.js").SystemMailPolicy[];
  resolveActor?(sender: string): Promise<Principal>;
  authorizeRecipient?(recipient: string, owner: Principal): Promise<void>;
  renderNotification?(notice: MailNotice): string;
  parseReply?(
    message: MailMessage,
    wait: { id: string; kind: string },
  ): Data | undefined;
}
