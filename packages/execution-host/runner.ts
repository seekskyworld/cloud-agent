/** 子进程仅处理一次可信模块调用；不拥有数据库租约或提交任务结果的权限。 */
import {
  type Module,
  type Data,
  type Step,
  type Principal,
  type ExecutionContext,
  type Task,
} from "../contracts/index.js";
import { ExecutionFailure } from "../contracts/failure.js";
import type { ProcessModule, Operation } from "./index.js";
process.once(
  "message",
  async (message: {
    spec: ProcessModule;
    operation: Operation;
    args: unknown[];
  }) => {
    try {
      const exports = await import(message.spec.entry);
      const factory: unknown = exports[message.spec.exportName];
      const module: Module =
        typeof factory === "function"
          ? await factory(message.spec.config ?? {})
          : factory;
      const value = await dispatch(module, message.operation, message.args);
      if (Buffer.byteLength(JSON.stringify(value) ?? "null") > 2_000_000)
        throw new ExecutionFailure("unknown", "EXECUTOR_OUTPUT_TOO_LARGE");
      process.send?.({ ok: true, value });
    } catch (error) {
      const failure =
        error instanceof ExecutionFailure
          ? error
          : new ExecutionFailure("unknown", "PLUGIN_FAILED");
      process.send?.({
        ok: false,
        category: failure.category,
        code: failure.code,
        ...failure.options,
      });
    }
  },
);
async function dispatch(module: Module, operation: Operation, args: unknown[]) {
  const signal = new AbortController().signal;
  if (operation === "next")
    return module.next(args[0] as Data, args[1] as Step[]);
  if (operation === "validate")
    return module.validateContext?.(
      args[0] as Step[],
      args[1] as Principal,
      signal,
    );
  if (operation === "authorize")
    return module.authorizeRead?.(
      args[0] as Task,
      args[1] as Principal,
      signal,
      args[2] as Step[],
    );
  const tool = module.tools.find((tool) => tool.name === args[0]);
  if (!tool)
    throw new ExecutionFailure("permanent", "TOOL_NOT_ALLOWED", {
      notAccepted: true,
    });
  const context = { ...(args[2] as ExecutionContext), signal };
  if (operation === "reconcile") {
    if (!tool.reconcile)
      throw new ExecutionFailure("unknown", "RECONCILIATION_UNAVAILABLE");
    return tool.reconcile(args[1] as Data, context);
  }
  return tool.execute(args[1] as Data, context);
}
