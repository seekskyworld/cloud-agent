/** 只传安全错误码；写入只有适配器明确证明未被接收时才允许重试。 */
import { Problem, type Outcome } from "./index.js";
export type FailureCategory =
  | "permanent"
  | "authorization"
  | "transient"
  | "rate_limited"
  | "unknown";
export class ExecutionFailure extends Error {
  readonly code: string;
  constructor(
    readonly category: FailureCategory,
    code: string,
    readonly options: { retryAfterMs?: number; notAccepted?: boolean } = {},
  ) {
    super("Execution failed");
    this.code = /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "EXECUTION_FAILED";
  }
}
export function failureOutcome(
  error: unknown,
  effect: "read" | "write",
  reference: string,
  fallback: string,
): Outcome {
  if (
    effect === "write" &&
    !(error instanceof ExecutionFailure && error.options.notAccepted)
  )
    return { kind: "unknown", reconciliationRef: reference };
  const failure =
    error instanceof ExecutionFailure ? error : fromProblem(error, fallback);
  if (failure.category === "unknown")
    return { kind: "unknown", reconciliationRef: reference };
  if (["permanent", "authorization"].includes(failure.category))
    return {
      kind: "failed",
      code: failure.code,
      message: failure.code,
      category: failure.category,
    };
  return {
    kind: "retryable",
    code: failure.code,
    category: failure.category,
    retryAfterMs: failure.options.retryAfterMs,
  };
}
function fromProblem(error: unknown, fallback: string): ExecutionFailure {
  if (!(error instanceof Problem))
    return new ExecutionFailure("transient", fallback);
  const category =
    error.status === 429
      ? "rate_limited"
      : [408, 425, 504].includes(error.status)
        ? "transient"
        : [401, 403].includes(error.status)
          ? "authorization"
          : error.status >= 400 && error.status < 500
            ? "permanent"
            : "transient";
  return new ExecutionFailure(category, error.code);
}
export function retryDelay(
  value: number | undefined,
  attempts: number,
): number {
  // 供应商明确的等待窗口不被指数退避上限截短；超出可表达范围则拒绝执行。
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0 || value > 2_147_483_647)
  )
    throw new Problem(422, "RETRY_DELAY_INVALID");
  return Math.max(100, value ?? Math.min(60_000, 500 * 2 ** attempts));
}
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
