/** 循环瞬态故障有界退避；配置/协议错误上抛，由宿主停止领取并排空。 */
import { setTimeout as delay } from "node:timers/promises";
import { Problem } from "../contracts/index.js";
import type { Operations } from "../observability/service.js";
export function fatalLoopError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return (
    ["28P01", "3D000", "42P01", "42703", "42501"].includes(String(code)) ||
    (error instanceof Problem &&
      ["CONFIG_INVALID", "BUSINESS_SDK_INCOMPATIBLE"].includes(error.code))
  );
}
export async function runLoop(options: {
  id: string;
  kind: string;
  operations: Pick<Operations, "loopHeartbeat">;
  stopping: () => boolean;
  tick: () => Promise<unknown>;
  intervalMs: number;
}) {
  let failures = 0;
  while (!options.stopping()) {
    let error: string | null = null;
    let worked: unknown;
    try {
      worked = await options.tick();
      failures = 0;
    } catch (cause) {
      if (fatalLoopError(cause)) throw cause;
      failures++;
      error = "CYCLE_FAILED";
    }
    try {
      await options.operations.loopHeartbeat(options.id, options.kind, error);
    } catch (cause) {
      if (fatalLoopError(cause)) throw cause;
      // 数据库不可用时旧心跳自然过期，避免记录成功或快速重试。
      failures++;
    }
    const pause = failures
      ? Math.min(30_000, 100 * 2 ** Math.min(failures, 8)) *
        (0.75 + Math.random() / 2)
      : worked === true
        ? 0
        : options.intervalMs;
    if (!options.stopping() && pause) await delay(pause);
  }
}
