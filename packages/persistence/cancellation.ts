/** NOTIFY 只是唤醒提示；收到后重读租约，断线时仍依靠 Worker 心跳保证正确性。 */
import type { Pool, PoolClient } from "pg";
export class CancellationNotifications {
  private listeners = new Map<string, Set<() => void>>();
  private client?: PoolClient;
  private connecting?: Promise<void>;
  private closed = false;
  constructor(private pool: Pool) {}
  async watch(token: string, callback: () => void) {
    const listeners = this.listeners.get(token) ?? new Set<() => void>();
    listeners.add(callback);
    this.listeners.set(token, listeners);
    await this.connect();
    return () => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(token);
    };
  }
  async connect() {
    if (this.client || this.closed) return;
    return (this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    }));
  }
  private async open() {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const current = client;
      const lost = () => {
        if (this.client === current) {
          this.client = undefined;
          current.release(true);
        }
      };
      client.on("error", lost);
      client.on("end", lost);
      client.on("notification", (message) => {
        if (message.channel === "cloud_agent_cancel" && message.payload)
          for (const callback of this.listeners.get(message.payload) ?? [])
            callback();
      });
      await client.query("LISTEN cloud_agent_cancel");
      this.client = client;
    } catch {
      client?.release(true); /* 心跳仍是权威兜底，下次心跳重新连接。 */
    }
  }
  async close() {
    this.closed = true;
    await this.connecting;
    const client = this.client;
    this.client = undefined;
    if (client) client.release(true);
    this.listeners.clear();
  }
}
