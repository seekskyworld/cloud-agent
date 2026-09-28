/** 渠道各自推进，至多两个账户持锁，给邮件和任务执行保留数据库连接。 */
import type { MessageChannel } from "./channel.js";
import type { Operations } from "../observability/service.js";
export class ChannelHub {
  private active = new Map<string, Promise<void>>();
  private cursor = 0;
  constructor(
    private channels: MessageChannel[],
    private operations: Pick<Operations, "loopHeartbeat">,
    private workerId: string,
  ) {}
  async tick(): Promise<void> {
    for (let i = 0; i < this.channels.length && this.active.size < 2; i++) {
      const channel = this.channels[this.cursor++ % this.channels.length]!;
      const id = channel.settings.id;
      if (this.active.has(id)) continue;
      const pending = this.run(channel).finally(() => this.active.delete(id));
      this.active.set(id, pending);
    }
    // 单个挂起账户不会阻挡另一执行槽；关闭时仍等待实际调用退出。
    if (this.active.size)
      await Promise.race([
        ...this.active.values(),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
  }
  async close() {
    await Promise.allSettled(this.active.values());
  }
  private async run(channel: MessageChannel) {
    let error: string | null = null;
    try {
      await channel.tick();
    } catch {
      error = "CHANNEL_CYCLE_FAILED";
    }
    try {
      await this.operations.loopHeartbeat(
        this.workerId,
        `channel_${channel.settings.id}`,
        error,
      );
    } catch {
      /* 数据库断连时依靠已有心跳过期；不产生未处理拒绝。 */
    }
  }
}
