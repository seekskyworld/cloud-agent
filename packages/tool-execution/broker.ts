import { failureOutcome } from "../contracts/failure.js";
/** 工具执行边界：实时授权、Schema 校验、超时和副作用恢复分类。 */
import {
  requireCapability,
  type Data,
  type Json,
  type ExecutionContext,
  type Outcome,
  type Step,
  type Tool,
} from "../contracts/index.js";
import { abortable } from "../contracts/lifecycle.js";
export class ToolBroker {
  async execute(
    tool: Tool,
    input: Data,
    context: ExecutionContext,
    step: Step,
  ): Promise<Outcome> {
    requireCapability(context.principal, tool.capability);
    const parsed = tool.input.parse(input) as Data;
    const recovering = ["running", "unknown"].includes(step.status);
    if (recovering && tool.effect === "unsafe_write")
      return { kind: "unknown", reconciliationRef: step.id };
    if (recovering && tool.effect === "reconcilable_write" && !tool.reconcile)
      return { kind: "unknown", reconciliationRef: step.id };
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(tool.timeoutMs),
    ]);
    const execution = { ...context, signal };
    try {
      const outcome = await abortable(signal, () =>
        recovering && tool.reconcile
          ? tool.reconcile(parsed, execution)
          : tool.execute(parsed, execution),
      );
      if (outcome.kind === "succeeded") {
        const checked = tool.output.safeParse(outcome.output);
        if (!checked.success)
          return tool.effect === "read"
            ? {
                kind: "failed",
                code: "INVALID_TOOL_OUTPUT",
                message: "工具结果未通过校验",
              }
            : { kind: "unknown", reconciliationRef: step.id };
        return { ...outcome, output: checked.data as Json };
      }
      return outcome;
    } catch (error) {
      return failureOutcome(
        error,
        tool.effect === "read" ? "read" : "write",
        step.id,
        "TOOL_UNAVAILABLE",
      );
    }
  }
}
