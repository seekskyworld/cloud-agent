/** 多账户调度限制数据库占用；每个账户独立报告，失败不会取消同轮其他账户。 */
import { Problem } from "../contracts/index.js";
import type { MailChannel } from "./channel.js";
export type MailCycle = "receive" | "notify" | "send";
export class MailHub {
  constructor(readonly channels: MailChannel[]) {
    if (
      new Set(channels.map((channel) => channel.store.id)).size !==
      channels.length
    )
      throw new Error("MAIL_ACCOUNT_ID_CONFLICT");
    const physical = channels.map(
      ({ store }) =>
        store.settings.physicalIdentity ??
        JSON.stringify([
          store.settings.provider ?? "agentmail",
          (store.settings.address ?? store.settings.inbox).toLowerCase(),
        ]),
    );
    if (new Set(physical).size !== physical.length)
      throw new Error("MAIL_CONSUMER_CONFLICT");
  }
  async tick(kind: MailCycle) {
    const pending = [...this.channels];
    // 三类循环各至多两个持锁账户，连接池仍有连接执行查询与核心任务。
    await Promise.all(
      Array.from({ length: Math.min(2, pending.length) }, async () => {
        for (
          let channel = pending.shift();
          channel;
          channel = pending.shift()
        ) {
          let error: string | null = null;
          try {
            await {
              receive: () => channel!.receiveTick(),
              notify: () => channel!.notifyTick(),
              send: () => channel!.sendTick(),
            }[kind]();
          } catch (cause) {
            error = cause instanceof Problem ? cause.code : "MAIL_CYCLE_FAILED";
          }
          try {
            await channel.store.health(kind, error);
          } catch {
            /* 数据库故障时由心跳过期显示失联，不影响其他账户继续。 */
          }
        }
      }),
    );
  }
}
