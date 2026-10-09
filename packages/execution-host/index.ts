/** 执行器只管理调用生命周期；任务租约、权限和副作用判定仍由宿主持有。 */
import { fork } from "node:child_process";
import { z } from "zod";
import { ExecutionFailure } from "../contracts/failure.js";
import type { Data, Module, Step, Action } from "../contracts/index.js";
import { bounded } from "../contracts/lifecycle.js";
import type { ProcessModule } from "../contracts/execution.js";
export type { ProcessModule } from "../contracts/execution.js";
export type Operation =
  | "next"
  | "validate"
  | "authorize"
  | "execute"
  | "reconcile";
export interface ExecutionHost {
  invoke(
    spec: ProcessModule,
    operation: Operation,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}
const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    category: z.enum([
      "permanent",
      "authorization",
      "transient",
      "rate_limited",
      "unknown",
    ]),
    code: z.string(),
    notAccepted: z.boolean().optional(),
    retryAfterMs: z.number().optional(),
  }),
]);
export class ProcessExecutionHost implements ExecutionHost {
  private running = new Set<() => void>();
  private closed = false;
  constructor(private concurrency = 4) {}
  invoke(
    spec: ProcessModule,
    operation: Operation,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || this.running.size >= this.concurrency)
      return Promise.reject(
        new ExecutionFailure("transient", "EXECUTOR_UNAVAILABLE", {
          notAccepted: true,
        }),
      );
    if (
      !spec.entry.startsWith("file:") ||
      !spec.revision ||
      !/^[a-zA-Z_$][\w$]*$/.test(spec.exportName)
    )
      return Promise.reject(
        new ExecutionFailure("permanent", "EXECUTOR_CONFIG_INVALID", {
          notAccepted: true,
        }),
      );
    const request = { spec, operation, args };
    if (Buffer.byteLength(JSON.stringify(request)) > 2_000_000)
      return Promise.reject(
        new ExecutionFailure("permanent", "EXECUTOR_INPUT_TOO_LARGE", {
          notAccepted: true,
        }),
      );
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = fork(new URL("./runner.js", import.meta.url), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
        // 不继承环境凭据；该模式用于可信插件，不能替代容器安全沙箱。
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
        execArgv: [
          ...process.execArgv.filter((a) => !a.startsWith("--test")),
          `--max-old-space-size=${Math.max(32, Math.min(4096, spec.memoryMb ?? 128))}`,
        ],
      });
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        this.running.delete(abort);
        child.kill("SIGKILL");
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () =>
        finish(new ExecutionFailure("unknown", "EXECUTOR_INTERRUPTED"));
      this.running.add(abort);
      const timer = setTimeout(abort, spec.timeoutMs ?? 15_000);
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", () =>
        finish(new ExecutionFailure("unknown", "EXECUTOR_FAILED")),
      );
      child.once("exit", () =>
        finish(new ExecutionFailure("unknown", "EXECUTOR_EXITED")),
      );
      child.once("message", (raw) => {
        const result = Reply.safeParse(raw);
        if (!result.success)
          return finish(
            new ExecutionFailure("unknown", "EXECUTOR_INVALID_REPLY"),
          );
        const reply = result.data;
        if (reply.ok) finish(undefined, reply.value);
        else
          finish(
            new ExecutionFailure(reply.category, reply.code, {
              notAccepted: reply.notAccepted,
              retryAfterMs: reply.retryAfterMs,
            }),
          );
      });
      child.send(request, (error) => {
        if (error)
          finish(new ExecutionFailure("unknown", "EXECUTOR_SEND_FAILED"));
      });
      if (signal.aborted) abort();
    });
  }
  async close() {
    this.closed = true;
    for (const abort of [...this.running]) abort();
  }
}
/** 异步扩展统一转发，Schema 与 capability 保留在宿主侧验证。 */
export function isolateModule(module: Module, host: ExecutionHost): Module {
  const spec = module.execution;
  if (!spec) return module;
  return {
    ...module,
    tools: module.tools.map((tool) => ({
      ...tool,
      execute: async (input, context) =>
        (await host.invoke(
          spec,
          "execute",
          [tool.name, input, { ...context, signal: undefined }],
          context.signal,
        )) as Awaited<ReturnType<typeof tool.execute>>,
      ...(tool.reconcile
        ? {
            reconcile: async (
              input: Data,
              context: Parameters<typeof tool.execute>[1],
            ) =>
              (await host.invoke(
                spec,
                "reconcile",
                [tool.name, input, { ...context, signal: undefined }],
                context.signal,
              )) as Awaited<ReturnType<typeof tool.execute>>,
          }
        : {}),
    })),
    ...(module.validateContext
      ? {
          validateContext: async (
            steps: Step[],
            principal: Parameters<NonNullable<Module["validateContext"]>>[1],
            signal: AbortSignal,
          ) => {
            await host.invoke(spec, "validate", [steps, principal], signal);
          },
        }
      : {}),
    ...(module.authorizeRead
      ? {
          authorizeRead: async (
            task: Parameters<NonNullable<Module["authorizeRead"]>>[0],
            principal: Parameters<NonNullable<Module["authorizeRead"]>>[1],
            signal: AbortSignal,
            steps: Step[],
          ) => {
            await host.invoke(
              spec,
              "authorize",
              [task, principal, steps],
              signal,
            );
          },
        }
      : {}),
  };
}
export async function nextAction(
  host: ExecutionHost,
  module: Module,
  input: Data,
  steps: Step[],
  signal: AbortSignal,
): Promise<Action> {
  if (!module.execution) return module.next(input, steps);
  return (await bounded(
    module.execution.timeoutMs ?? 15_000,
    (deadline) =>
      host.invoke(module.execution!, "next", [input, steps], deadline),
    signal,
  )) as Action;
}
