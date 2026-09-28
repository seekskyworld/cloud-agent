/** 调用总时限不被进展延长；只有适配器报告的有效增量能重置停顿计时。 */
import { ExecutionFailure } from "../contracts/failure.js";
export function modelDeadline(
  parent: AbortSignal,
  deadlineAt: number,
  firstMs?: number,
  idleMs?: number,
) {
  const controller = new AbortController();
  let failure: ExecutionFailure | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const expire = (code: string) => {
    failure = new ExecutionFailure("transient", code, { retryAfterMs: 5000 });
    controller.abort(failure);
  };
  const total = setTimeout(
    () => expire("MODEL_EXECUTION_TIMEOUT"),
    Math.max(1, deadlineAt - Date.now()),
  );
  const reset = (ms: number | undefined, code: string) => {
    clearTimeout(progressTimer);
    if (ms !== undefined) progressTimer = setTimeout(() => expire(code), ms);
  };
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    start: () => reset(firstMs, "MODEL_FIRST_OUTPUT_TIMEOUT"),
    progress: () => {
      if (!controller.signal.aborted) reset(idleMs, "MODEL_IDLE_TIMEOUT");
    },
    failure: () => failure,
    close: () => {
      clearTimeout(total);
      clearTimeout(progressTimer);
    },
  };
}
