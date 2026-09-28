/** 持久通知只由任务状态生成；发送前再次检查身份、资源可见性及等待是否仍有效。 */
import { sendPending } from "./delivery.js";
import type { BusinessMail } from "./business.js";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../contracts/index.js";
import type { IdentityService } from "../identity/service.js";
import type { TaskService } from "../runtime/service.js";
import type { MailProvider } from "./contracts.js";
import { MailStore, type NotificationCandidate } from "./store.js";
export class MailNotifications {
  constructor(
    private store: MailStore,
    private identity: IdentityService,
    private service: TaskService,
    private provider: MailProvider,
    private business?: BusinessMail,
  ) {}
  private owner(row: NotificationCandidate): Principal {
    return {
      id: row.principal_id,
      workspace_id: this.store.settings.workspace,
      capabilities: [],
      enabled: false,
      role: "member",
    };
  }
  private async authorize(owner: Principal, recipient: string) {
    if (this.store.settings.bindings[recipient] !== owner.id)
      throw new Problem(403, "MAIL_BINDING_REVOKED");
    const principal = await this.identity.current(owner.workspace_id, owner.id);
    requireCapability(principal, "mail:use");
  }
  async collect() {
    const rows = await this.store.notificationCandidates();
    for (const row of rows) {
      await this.enqueue(row);
      await this.store.markNotificationChecked(row.task_id);
    }
  }
  private async enqueue(row: NotificationCandidate) {
    const owner = this.owner(row);
    const notice = await this.service.notification(owner, row.task_id);
    if (!notice) return;
    let body = "",
      state = this.store.settings.sendEnabled ? "pending" : "draft",
      error: string | null = null;
    try {
      await this.authorize(owner, row.recipient);
      if (!notice.task) throw new Problem(403, notice.error!);
      const task = notice.task;
      body = notice.waitId
        ? `${notice.reason}\n\n${notice.status === "waiting_approval" ? "直接回复 approve 或 reject（不要包含引用原文）。" : "直接回复符合以下结构的 JSON（不要包含引用原文）：\n" + JSON.stringify(notice.schema)}\n\n任务：${task.id}`
        : `任务：${task.id}\n状态：${task.status}\n${task.status === "succeeded" ? JSON.stringify(task.result, null, 2) : (task.error ?? "")}`;
      if (body.length > 60_000) throw new Problem(422, "MAIL_RESULT_TOO_LARGE");
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
      state = "cancelled";
      error = e.code;
      body = "";
    }
    await this.store.enqueueNotification({
      taskId: row.task_id,
      key: notice.key,
      waitId: notice.waitId,
      status: notice.status,
      recipient: row.recipient,
      replyTo: row.reply_to,
      subject: `Re: ${row.subject}`,
      body,
      state,
      error,
    });
  }
  async send(signal: AbortSignal) {
    return sendPending(this.store, this.provider, signal, async (row) => {
      if (row.business_policy) {
        if (!this.business) throw new Problem(409, "MAIL_POLICY_UNAVAILABLE");
        return this.business.prepare(row, signal);
      }
      if (!row.task_id) throw new Problem(409, "MAIL_TASK_REQUIRED");
      const tracked = await this.store.notificationTask(row.task_id);
      if (!tracked) throw new Problem(409, "MAIL_TASK_REQUIRED");
      const owner = this.owner(tracked);
      await this.authorize(owner, row.recipient);
      const notice = await this.service.notification(owner, row.task_id);
      if (notice?.error) throw new Problem(403, notice.error);
      if (
        !notice ||
        notice.key !== row.notification_key ||
        notice.status !== row.task_status
      )
        throw new Problem(409, "MAIL_NOTIFICATION_STALE");
      return {
        id: row.id,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
        replyTo: row.reply_to,
      };
    });
  }
}
