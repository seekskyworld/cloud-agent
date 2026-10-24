/** Worker 停止领取后有限排空；超期退出由租约恢复接手，绝不推断远端动作未发生。 */
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { runLoop } from "../../packages/runtime/loop.js";
import { ChannelHub } from "../../packages/channels/hub.js";
import { loadConfig } from "../config.js";
import { createApplication } from "../application.js";
const container = await createApplication(loadConfig(), { role: "worker" });
let stopping = false;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
function stop() {
  stopping = true;
  // 和部署 stop_grace_period 配套；进程内不合作插件不得无限阻止重启。
  shutdownTimer ??= setTimeout(() => process.exit(1), 30_000);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
const id = `${hostname()}:${process.pid}:${randomUUID()}`;
const channelHub = new ChannelHub(container.channels, container.operations, id);
function loop(kind: string, intervalMs: number, tick: () => Promise<unknown>) {
  return runLoop({
    id,
    kind,
    intervalMs,
    tick,
    operations: container.operations,
    stopping: () => stopping,
  });
}
let lastEmptyClaim = 0;
let lastSlotHeartbeat = 0;
const pulse = setInterval(() => {
  void container.operations.heartbeat(id).catch(() => {});
}, 10_000);
const loops = [
  ...(container.channels.length
    ? [loop("channels", 100, () => channelHub.tick())]
    : []),
  ...(container.mailHub.channels.length
    ? (["receive", "notify", "send"] as const).map((kind) =>
        loop(`mail_${kind}`, 1000, () => container.mailHub.tick(kind)),
      )
    : []),
  loop("maintenance", 1000, async () => {
    await container.worker.modelLifecycle.reconcile((id) =>
      container.models.byEngineId(id),
    );
    await container.waits.expire();
    await container.schedules.tick();
    await container.businessJobs.tick();
    await container.groups.tick();
    await container.operations.pruneHeartbeats();
  }),
  ...Array.from({ length: container.config.WORKER_CONCURRENCY }, (_, slot) =>
    loop(`execute_${slot}`, 250, async () => {
      // 空闲时只有 0 号槽位快速轮询；其余槽位在最近一次领取落空后 3 秒内不领取，
      // 领到任务就恢复全速。避免几十个槽位每 250ms 争同一把准入锁（空闲时 CPU 与数据库空转）。
      if (slot > 0 && Date.now() - lastEmptyClaim < 3_000) {
        await delay(1_000);
        return false;
      }
      if (Date.now() - lastSlotHeartbeat > 1_000) {
        lastSlotHeartbeat = Date.now();
        await container.operations.heartbeat(id);
      }
      const worked = await container.worker.tick();
      if (worked) lastEmptyClaim = 0;
      else lastEmptyClaim = Date.now();
      return worked;
    }),
  ),
];
try {
  await Promise.all(loops);
} finally {
  stop();
  clearInterval(pulse);
  await Promise.allSettled(loops);
  await channelHub.close();
  await container.close();
  clearTimeout(shutdownTimer);
}
