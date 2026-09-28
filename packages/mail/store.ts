/** 邮件收件箱、线程和发件箱仓储；去重记录与任务关联持久保存。 */
import { randomUUID } from "node:crypto";
import { Problem, type Principal } from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { MailMessage, MailSettings } from "./contracts.js";
export interface OutboxRow {
  id: string;
  mailbox: string;
  task_id: string;
  notification_key: string;
  wait_id: string | null;
  task_status: string;
  recipient: string;
  reply_to: string;
  subject: string;
  body: string;
  state: string;
}
export interface NotificationCandidate {
  task_id: string;
  principal_id: string;
  recipient: string;
  reply_to: string;
  subject: string;
}
export class MailStore {
  constructor(
    readonly db: Database,
    readonly settings: MailSettings,
  ) {}
  get id() {
    return this.settings.id ?? this.settings.inbox;
  }
  async initialize() {
    const settings = this.settings;
    const digest =
      settings.accountFingerprint ??
      fingerprint([
        settings.provider ?? "agentmail",
        settings.inbox,
        settings.address ?? settings.inbox,
      ]);
    const row = await this.db.pool.query(
      `INSERT INTO mailboxes(id,workspace_id,provider,remote_id,address,config_hash) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET config_hash=COALESCE(mailboxes.config_hash,EXCLUDED.config_hash),address=COALESCE(mailboxes.address,EXCLUDED.address)
      WHERE mailboxes.workspace_id=EXCLUDED.workspace_id AND mailboxes.provider=EXCLUDED.provider AND mailboxes.remote_id=EXCLUDED.remote_id
      AND (mailboxes.address IS NULL OR mailboxes.address=EXCLUDED.address) AND (mailboxes.config_hash IS NULL OR mailboxes.config_hash=EXCLUDED.config_hash)
      RETURNING id`,
      [
        this.id,
        settings.workspace,
        settings.provider ?? "agentmail",
        settings.inbox,
        settings.address ?? settings.inbox,
        digest,
      ],
    );
    if (!row.rowCount) throw new Problem(409, "MAIL_ACCOUNT_CHANGED");
  }
  async health(kind: string, error: string | null) {
    await this.initialize();
    await this.db.pool.query(
      `INSERT INTO mail_health(mailbox,kind,last_success,error) VALUES($1,$2,CASE WHEN $3::text IS NULL THEN now() END,$3)
      ON CONFLICT(mailbox,kind) DO UPDATE SET seen_at=now(),last_success=CASE WHEN $3::text IS NULL THEN now() ELSE mail_health.last_success END,error=$3`,
      [this.id, kind, error],
    );
  }
  /** 回调和轮询共享消息唯一键；同事件换内容直接拒绝。 */
  async receive(event: { id: string; messageId: string; digest: string }) {
    await this.initialize();
    return this.db.transaction(async (c) => {
      await c.query(
        "INSERT INTO mail_webhooks(mailbox,event_id,message_id,digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [this.id, event.id, event.messageId, event.digest],
      );
      const previous = (
        await c.query<{ message_id: string; digest: string }>(
          "SELECT message_id,digest FROM mail_webhooks WHERE mailbox=$1 AND event_id=$2",
          [this.id, event.id],
        )
      ).rows[0]!;
      if (
        previous.message_id !== event.messageId ||
        previous.digest !== event.digest
      )
        throw new Problem(409, "MAIL_EVENT_CONFLICT");
      const result = await c.query(
        "INSERT INTO mail_inbound(mailbox,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.id, event.messageId],
      );
      return { accepted: true, duplicate: !result.rowCount };
    });
  }
  async linkedReply(message: MailMessage, principal: Principal) {
    if (!message.inReplyTo) return undefined;
    return (
      await this.db.pool.query<OutboxRow>(
        `SELECT o.* FROM mail_outbox o JOIN mail_tasks t ON t.task_id=o.task_id
      WHERE o.mailbox=$1 AND o.recipient=$2 AND t.principal_id=$3
      AND (o.provider_id=$4 OR '<' || o.id::text || '@cloud-agent.local>'=$4)`,
        [this.id, message.sender, principal.id, message.inReplyTo],
      )
    ).rows[0];
  }
  async finish(message: MailMessage, taskId: string, principalId: string) {
    await this.db.transaction(async (c) => {
      await c.query(
        "INSERT INTO mail_tasks(task_id,mailbox,recipient,reply_to,subject,principal_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          taskId,
          this.id,
          message.sender,
          message.messageId ?? message.id,
          message.subject,
          principalId,
        ],
      );
      await c.query(
        "UPDATE mail_inbound SET state='processed',task_id=$3,error=NULL WHERE mailbox=$1 AND message_id=$2",
        [this.id, message.id, taskId],
      );
    });
  }
  async status() {
    await this.initialize();
    const mailbox = (
      await this.db.pool.query(
        "SELECT id,provider,remote_id,address,blocked_reason,last_error,last_success,next_poll FROM mailboxes WHERE id=$1",
        [this.id],
      )
    ).rows[0];
    const inbound = (
      await this.db.pool.query(
        "SELECT message_id,state,attempts,error,task_id,created_at FROM mail_inbound WHERE mailbox=$1 ORDER BY created_at DESC LIMIT 100",
        [this.id],
      )
    ).rows;
    const outbox = (
      await this.db.pool.query(
        "SELECT id,task_id,state,error,provider_id,created_at FROM mail_outbox WHERE mailbox=$1 ORDER BY created_at DESC LIMIT 100",
        [this.id],
      )
    ).rows;
    const health = (
      await this.db.pool.query(
        "SELECT kind,seen_at,last_success,error FROM mail_health WHERE mailbox=$1",
        [this.id],
      )
    ).rows;
    return {
      health,
      mailbox,
      sendEnabled: this.settings.sendEnabled,
      inbound,
      outbox,
    };
  }
  async notificationCandidates(): Promise<NotificationCandidate[]> {
    return (
      await this.db.pool.query<NotificationCandidate>(
        "SELECT * FROM mail_tasks WHERE mailbox=$1 ORDER BY checked_at,task_id LIMIT 50",
        [this.id],
      )
    ).rows;
  }
  async markNotificationChecked(taskId: string) {
    await this.db.pool.query(
      "UPDATE mail_tasks SET checked_at=now() WHERE mailbox=$1 AND task_id=$2",
      [this.id, taskId],
    );
  }
  async enqueueNotification(value: {
    taskId: string;
    key: string;
    waitId: string | null;
    status: string;
    recipient: string;
    replyTo: string;
    subject: string;
    body: string;
    state: string;
    error: string | null;
  }) {
    await this.db.pool.query(
      "INSERT INTO mail_outbox(id,mailbox,task_id,notification_key,wait_id,task_status,recipient,reply_to,subject,body,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(task_id,notification_key) DO NOTHING",
      [
        randomUUID(),
        this.id,
        value.taskId,
        value.key,
        value.waitId,
        value.status,
        value.recipient,
        value.replyTo,
        value.subject,
        value.body,
        value.state,
        value.error,
      ],
    );
  }
  async nextPending(): Promise<OutboxRow | undefined> {
    return (
      await this.db.pool.query<OutboxRow>(
        "SELECT * FROM mail_outbox WHERE mailbox=$1 AND state='pending' ORDER BY created_at LIMIT 1",
        [this.id],
      )
    ).rows[0];
  }
  async notificationTask(
    taskId: string,
  ): Promise<NotificationCandidate | undefined> {
    return (
      await this.db.pool.query<NotificationCandidate>(
        "SELECT * FROM mail_tasks WHERE task_id=$1 AND mailbox=$2",
        [taskId, this.id],
      )
    ).rows[0];
  }
  async cancelOutbox(id: string, error: string) {
    await this.db.pool.query(
      "UPDATE mail_outbox SET state='cancelled',error=$2,updated_at=now() WHERE id=$1 AND state='pending'",
      [id, error],
    );
  }
  async claimOutbox(id: string) {
    return Boolean(
      (
        await this.db.pool.query(
          "UPDATE mail_outbox SET state='sending',attempts=attempts+1,updated_at=now() WHERE id=$1 AND state='pending' RETURNING id",
          [id],
        )
      ).rowCount,
    );
  }
  async sentOutbox(id: string, providerId: string) {
    await this.db.pool.query(
      "UPDATE mail_outbox SET state='sent',provider_id=$2,updated_at=now() WHERE id=$1 AND state IN ('sending','uncertain')",
      [id, providerId],
    );
  }
  async failOutbox(id: string, state: string, error: string) {
    await this.db.pool.query(
      "UPDATE mail_outbox SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='sending'",
      [id, state, error],
    );
  }
  async block(error: string) {
    await this.db.pool.query(
      "UPDATE mailboxes SET blocked_reason=$2 WHERE id=$1",
      [this.id, error],
    );
  }
  /** 管理恢复仅重读来信；未知发信必须人工确认 sent 或 cancelled，不提供盲目重发。 */
  async manage(
    actor: Principal,
    input: {
      action: "resume" | "retry" | "resolve" | "reset-cursor";
      target: string;
      reason: string;
      resolution?: "sent" | "cancelled";
      providerId?: string;
    },
  ) {
    if (
      actor.workspace_id !== this.settings.workspace ||
      actor.role !== "superadmin"
    )
      throw new Problem(403, "FORBIDDEN");
    await this.initialize();
    await this.db.transaction(async (c) => {
      const actorRow = await c.query(
        "SELECT 1 FROM runtime_lock_principals($1,ARRAY[$2]) WHERE enabled AND role='superadmin'",
        [actor.workspace_id, actor.id],
      );
      if (!actorRow.rowCount) throw new Problem(403, "FORBIDDEN");
      // 与收取循环共用 advisory lock；忙时返回冲突，避免游标重置被旧扫描覆盖。
      if (input.action !== "resolve") {
        const lock = await c.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
          [`mail:${this.id}:receive`],
        );
        if (!lock.rows[0]!.locked) throw new Problem(409, "MAIL_ACCOUNT_BUSY");
      }
      let count: number | null;
      if (input.action === "reset-cursor") {
        count = (
          await c.query(
            "UPDATE mailboxes SET cursor=NULL,blocked_reason=NULL,last_error=NULL,next_poll=now() WHERE id=$1",
            [this.id],
          )
        ).rowCount;
      } else if (input.action === "resume") {
        count = (
          await c.query(
            "UPDATE mailboxes SET blocked_reason=NULL,last_error=NULL,next_poll=now() WHERE id=$1",
            [this.id],
          )
        ).rowCount;
      } else if (input.action === "retry") {
        count = (
          await c.query(
            "UPDATE mail_inbound SET state='pending',attempts=0,error=NULL,next_attempt=now() WHERE mailbox=$1 AND message_id=$2 AND state IN ('failed','quarantined')",
            [this.id, input.target],
          )
        ).rowCount;
      } else {
        if (
          !input.resolution ||
          (input.resolution === "sent" && !input.providerId)
        )
          throw new Problem(400, "MAIL_RESOLUTION_REQUIRED");
        count = (
          await c.query(
            "UPDATE mail_outbox SET state=$3,provider_id=$4,error=NULL,updated_at=now() WHERE mailbox=$1 AND id::text=$2 AND state='uncertain'",
            [this.id, input.target, input.resolution, input.providerId ?? null],
          )
        ).rowCount;
      }
      if (!count) throw new Problem(409, "MAIL_STATE_CHANGED");
      await c.query(
        "INSERT INTO mail_audit(mailbox,actor,action,target,reason) VALUES($1,$2,$3,$4,$5)",
        [this.id, actor.id, input.action, input.target, input.reason],
      );
    });
  }
}
