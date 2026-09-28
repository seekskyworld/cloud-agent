/** Worker 停止领取后有限排空；超期退出由租约恢复接手，绝不推断远端动作未发生。 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { runLoop } from "../../packages/runtime/loop.js";
import { ChannelHub } from "../../packages/channels/hub.js";
import { loadConfig } from "../config.js";
import { createApplication } from "../application.js";
const container = await createApplication(loadConfig());
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
      await container.operations.heartbeat(id);
      return container.worker.tick();
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
