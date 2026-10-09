/** 通用持久渠道：回调先存事件，后台经统一任务入口处理并持久通知；未知投递不重发。 */
import { abortable } from "../contracts/lifecycle.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { Database } from "../persistence/database.js";
import type { IdentityService } from "../identity/service.js";
import type { TaskService } from "../runtime/service.js";
import { ChannelTasks } from "./tasks.js";
import { deliveryFailure } from "./delivery.js";
import {
  ChannelMessage,
  type ChannelProvider,
  type ChannelSettings,
} from "../connectors/channel.js";
export {
  ChannelMessage,
  type ChannelProvider,
  type ChannelSettings,
} from "../connectors/channel.js";
export class MessageChannel {
  private gateway: ChannelTasks;
  constructor(
    readonly settings: ChannelSettings,
    private provider: ChannelProvider,
    private db: Database,
    private identity: IdentityService,
    private tasks: TaskService,
  ) {
    this.gateway = new ChannelTasks(identity, tasks);
  }
  async initialize() {
    const result = await this.db.pool.query(
      `INSERT INTO channel_accounts(id,workspace_id,config_hash) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE channel_accounts.workspace_id=EXCLUDED.workspace_id AND channel_accounts.config_hash=EXCLUDED.config_hash RETURNING id`,
      [
        this.settings.id,
        this.settings.workspace,
        fingerprint([this.settings.identity, this.settings.moduleId]),
      ],
    );
    if (!result.rowCount) throw new Problem(409, "CHANNEL_ACCOUNT_CHANGED");
  }
  async receive(raw: Buffer, headers: Record<string, unknown>) {
    const event = ChannelMessage.parse(
      await this.provider.verify(raw, headers),
    );
    await this.initialize();
    const result = await this.db.pool.query(
      `INSERT INTO channel_inbound(account,id,digest,payload) VALUES($1,$2,$3,$4) ON CONFLICT(account,id) DO UPDATE SET id=EXCLUDED.id WHERE channel_inbound.digest=EXCLUDED.digest RETURNING state`,
      [
        this.settings.id,
        event.eventId,
        fingerprint(event),
        JSON.stringify(event),
      ],
    );
    if (!result.rowCount) throw new Problem(409, "CHANNEL_EVENT_CONFLICT");
    return { accepted: true };
  }
  private async consume(event: ChannelMessage) {
    const s = this.settings;
    const principal = await this.gateway.actor(
      s.workspace,
      event.subject,
      s.bindings,
      s.capability ?? "channel:use",
    );
    const reply = event.replyTo
      ? (
          await this.db.pool.query<{ task_id: string; wait_id: string | null }>(
            "SELECT task_id,wait_id FROM channel_outbox WHERE id=$1 AND account=$2 AND subject=$3 AND principal_id=$4 AND state='sent'",
            [event.replyTo, s.id, event.subject, principal.id],
          )
        ).rows[0]
      : undefined;
    if (event.replyTo && !reply)
      throw new Problem(403, "CHANNEL_REPLY_FORBIDDEN");
    const taskId = await this.gateway.submit({
      principal,
      key: `channel:${fingerprint([s.id, event.eventId])}`,
      namespace: `channel:${s.id}`,
      thread: event.threadId,
      title: s.id,
      route: () => ({ moduleId: s.moduleId, input: event.input }),
      reply: reply
        ? {
            taskId: reply.task_id,
            waitId: reply.wait_id,
            response: event.response,
          }
        : undefined,
    });
    await this.db.transaction(async (c) => {
      await c.query(
        "INSERT INTO channel_tasks(account,task_id,principal_id,subject) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [s.id, taskId, principal.id, event.subject],
      );
      await c.query(
        "UPDATE channel_inbound SET state='processed',task_id=$3 WHERE account=$1 AND id=$2",
        [s.id, event.eventId, taskId],
      );
    });
  }
  private async collect() {
    const rows = (
      await this.db.pool.query<{
        task_id: string;
        principal_id: string;
        subject: string;
      }>(
        "SELECT * FROM channel_tasks WHERE account=$1 ORDER BY checked_at,task_id LIMIT 50",
        [this.settings.id],
      )
    ).rows;
    for (const row of rows) {
      const actor = {
        id: row.principal_id,
        workspace_id: this.settings.workspace,
        enabled: false,
        capabilities: [],
        role: "member" as const,
      };
      const notice = await this.tasks.notification(actor, row.task_id);
      if (notice) {
        let permitted =
          this.settings.bindings[row.subject] === row.principal_id &&
          !notice.error;
        try {
          await this.gateway.actor(
            this.settings.workspace,
            row.subject,
            this.settings.bindings,
            this.settings.capability ?? "channel:use",
          );
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          permitted = false;
        }
        const payload = permitted
          ? {
              taskId: row.task_id,
              status: notice.status,
              result: notice.task?.result ?? null,
              waitId: notice.waitId,
              reason: notice.reason,
              schema: notice.schema,
            }
          : {};
        await this.db.pool.query(
          "INSERT INTO channel_outbox(id,account,task_id,notice_key,wait_id,subject,principal_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
          [
            randomUUID(),
            this.settings.id,
            row.task_id,
            notice.key,
            notice.waitId,
            row.subject,
            row.principal_id,
            JSON.stringify(payload),
            !permitted
              ? "cancelled"
              : this.settings.sendEnabled
                ? "pending"
                : "draft",
          ],
        );
      }
      await this.db.pool.query(
        "UPDATE channel_tasks SET checked_at=now() WHERE account=$1 AND task_id=$2",
        [this.settings.id, row.task_id],
      );
    }
  }
  private async send(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.db.pool.query(
      "UPDATE channel_outbox SET state='uncertain',error='DELIVERY_INTERRUPTED' WHERE account=$1 AND state='sending'",
      [this.settings.id],
    );
    if (!this.settings.sendEnabled) return;
    const row = (
      await this.db.pool.query<{
        id: string;
        task_id: string;
        principal_id: string;
        subject: string;
        notice_key: string;
        payload: unknown;
      }>(
        "SELECT * FROM channel_outbox WHERE account=$1 AND state='pending' ORDER BY created_at LIMIT 1",
        [this.settings.id],
      )
    ).rows[0];
    if (!row) return;
    try {
      const actor = await this.gateway.actor(
        this.settings.workspace,
        row.subject,
        this.settings.bindings,
        this.settings.capability ?? "channel:use",
      );
      if (actor.id !== row.principal_id)
        throw new Problem(403, "CHANNEL_BINDING_CHANGED");
      const notice = await this.tasks.notification(actor, row.task_id);
      if (!notice || notice.error || notice.key !== row.notice_key)
        throw new Problem(409, "CHANNEL_NOTICE_STALE");
      requireCapability(
        await this.identity.current(actor.workspace_id, actor.id),
        this.settings.capability ?? "channel:use",
      );
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      await this.db.pool.query(
        "UPDATE channel_outbox SET state='cancelled',error=$2 WHERE id=$1",
        [row.id, error.code],
      );
      return;
    }
    signal.throwIfAborted();
    await this.db.pool.query(
      "UPDATE channel_outbox SET state='sending' WHERE id=$1",
      [row.id],
    );
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      await abortable(deadline, () =>
        this.provider.send(row.id, row.payload, deadline),
      );
      signal.throwIfAborted();
      await this.db.pool.query(
        "UPDATE channel_outbox SET state='sent' WHERE id=$1 AND state='sending'",
        [row.id],
      );
    } catch (error) {
      const failure = deliveryFailure(error);
      await this.db.pool.query(
        "UPDATE channel_outbox SET state=$2,error=$3 WHERE id=$1 AND state='sending'",
        [row.id, failure.state, failure.code],
      );
    }
  }
  async status() {
    await this.initialize();
    const inbound = (
      await this.db.pool.query(
        "SELECT id,state,error,task_id FROM channel_inbound WHERE account=$1 ORDER BY created_at DESC LIMIT 100",
        [this.settings.id],
      )
    ).rows;
    const outbox = (
      await this.db.pool.query(
        "SELECT id,state,error,task_id FROM channel_outbox WHERE account=$1 ORDER BY created_at DESC LIMIT 100",
        [this.settings.id],
      )
    ).rows;
    return { id: this.settings.id, inbound, outbox };
  }
  async resolve(
    actor: Principal,
    input: { target: string; resolution: "sent" | "cancelled"; reason: string },
  ) {
    if (
      actor.workspace_id !== this.settings.workspace ||
      actor.role !== "superadmin"
    )
      throw new Problem(403, "FORBIDDEN");
    await this.db.transaction(async (c) => {
      const current = await c.query(
        "SELECT 1 FROM runtime_lock_principals($2,ARRAY[$1]) WHERE enabled AND role='superadmin'",
        [actor.id, actor.workspace_id],
      );
      if (!current.rowCount) throw new Problem(403, "FORBIDDEN");
      const result = await c.query(
        "UPDATE channel_outbox SET state=$3 WHERE id=$1 AND account=$2 AND state='uncertain'",
        [input.target, this.settings.id, input.resolution],
      );
      if (!result.rowCount) throw new Problem(409, "CHANNEL_STATE_CHANGED");
      await c.query(
        "INSERT INTO channel_audit(account,actor,target,resolution,reason) VALUES($1,$2,$3,$4,$5)",
        [
          this.settings.id,
          actor.id,
          input.target,
          input.resolution,
          input.reason,
        ],
      );
    });
  }
  async tick() {
    await this.initialize();
    const c = await this.db.pool.connect(),
      key = `channel:${this.settings.id}`;
    let held = false;
    const controller = new AbortController();
    const lost = () => controller.abort(new Problem(409, "CHANNEL_LOCK_LOST"));
    c.on("error", lost);
    try {
      held = (
        await c.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [key],
        )
      ).rows[0]!.locked;
      if (!held) return;
      const rows = (
        await c.query<{ payload: ChannelMessage }>(
          "SELECT payload FROM channel_inbound WHERE account=$1 AND state='pending' ORDER BY created_at LIMIT 5",
          [this.settings.id],
        )
      ).rows;
      for (const row of rows) {
        controller.signal.throwIfAborted();
        try {
          await this.consume(row.payload);
        } catch (error) {
          if (!(error instanceof Problem || error instanceof z.ZodError))
            throw error;
          await c.query(
            "UPDATE channel_inbound SET state='quarantined',error=$3 WHERE account=$1 AND id=$2",
            [
              this.settings.id,
              row.payload.eventId,
              error instanceof Problem ? error.code : "CHANNEL_INPUT_INVALID",
            ],
          );
        }
      }
      controller.signal.throwIfAborted();
      await this.collect();
      await this.send(controller.signal);
    } finally {
      let reusable = false;
      try {
        if (held)
          await c.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
        reusable = !controller.signal.aborted;
      } finally {
        c.off("error", lost);
        c.release(!reusable);
      }
    }
  }
}
