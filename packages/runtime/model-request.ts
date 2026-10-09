/** 模型参数与输出在平台边界验证，不把结构化结果声明等同于供应商原生约束。 */
import { compileJsonSchema } from "../contracts/json-schema.js";
import {
  Problem,
  type Json,
  type ModelEngine,
  type ModelRequest,
  type ModelTurn,
  type Tool,
} from "../contracts/index.js";
import { ExecutionFailure } from "../contracts/failure.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { ReasoningLevel } from "../contracts/index.js";

export function modelCheckpointHash(
  taskConfigHash: string,
  engineId: string,
  request: ModelRequest,
): string | undefined {
  if (!request.checkpoint) return undefined;
  return fingerprint({
    taskConfigHash,
    engineId,
    request: {
      ...request,
      reasoning: (request.reasoning ?? "none") as ReasoningLevel,
      cache: request.cache ?? "disabled",
      tools: [...new Set(request.tools)],
    },
  });
}
export function prepareModelRequest(
  request: ModelRequest,
  engine: ModelEngine,
  tools: Tool[],
): ModelRequest {
  validateCapabilities(request, engine, tools);
  validateRequestOptions(request, engine);
  for (const timeout of [request.firstOutputTimeoutMs, request.idleTimeoutMs]) {
    if (
      timeout !== undefined &&
      (!Number.isInteger(timeout) || timeout < 1 || timeout > 1_800_000)
    )
      throw new Problem(422, "MODEL_TIMEOUT_INVALID");
    if (
      timeout !== undefined &&
      !engine.capabilities?.progress &&
      !request.stream
    )
      throw new Problem(422, "MODEL_PROGRESS_UNSUPPORTED");
  }
  const budget = request.inputTokenBudget;
  const reasoning = request.reasoning ?? "none";
  const instructions = modelInstructions(request, engine);
  // 这些字段进入规范化请求，确保日志、指纹和适配器看到同一份语义。
  const prepared = {
    ...request,
    instructions,
    reasoning,
    cache: request.cache ?? "disabled",
    tools: [...new Set(request.tools)],
  };
  // UTF-8 字节数作为保守输入单位，不声称精确 tokenizer；包含工具 Schema 和协议开销。
  const size =
    Buffer.byteLength(JSON.stringify(prepared)) +
    Buffer.byteLength(
      JSON.stringify(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          input: t.input.toJSONSchema(),
        })),
      ),
    ) +
    1024;
  const units = engine.countTokens?.(prepared, tools) ?? size;
  if (!Number.isFinite(units) || units < 0)
    throw new Problem(422, "MODEL_TOKEN_COUNT_INVALID");
  if (budget !== undefined && units > budget)
    throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
  return prepared;
}
function validateRequestOptions(request: ModelRequest, engine: ModelEngine) {
  if (
    request.inputTokenBudget !== undefined &&
    (!Number.isInteger(request.inputTokenBudget) ||
      request.inputTokenBudget < 1 ||
      request.inputTokenBudget > 1_000_000)
  )
    throw new Problem(422, "MODEL_INPUT_BUDGET_INVALID");
  if (
    request.timeoutMs !== undefined &&
    (!Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1_000 ||
      request.timeoutMs > 1_800_000)
  )
    throw new Problem(422, "MODEL_TIMEOUT_INVALID");
  const reasoning = request.reasoning ?? "none";
  if (
    engine.capabilities?.reasoning &&
    !engine.capabilities.reasoning.includes(reasoning)
  )
    throw new Problem(422, "MODEL_REASONING_UNSUPPORTED");
  if (request.cache === "default" && engine.capabilities?.cache === false)
    throw new Problem(422, "MODEL_CACHE_UNSUPPORTED");
}
function modelInstructions(request: ModelRequest, engine: ModelEngine) {
  if (request.outputSchema === undefined) return request.instructions;
  if (!engine.capabilities?.structuredOutput)
    throw new Problem(422, "MODEL_STRUCTURED_OUTPUT_UNSUPPORTED");
  schemaValidator(request.outputSchema);
  return `${request.instructions}\nReturn only JSON matching this schema when no tool calls are needed:\n${JSON.stringify(request.outputSchema)}`;
}
function validateCapabilities(
  request: ModelRequest,
  engine: ModelEngine,
  tools: Tool[],
) {
  if (request.stream && !engine.stream)
    throw new Problem(422, "MODEL_STREAM_UNSUPPORTED");
  if (tools.length && engine.capabilities?.tools === false)
    throw new Problem(422, "MODEL_TOOLS_UNSUPPORTED");
  const modalities = engine.capabilities?.modalities ?? ["text"];
  for (const message of request.messages)
    for (const block of message.content ?? []) {
      if (!modalities.includes(block.type))
        throw new Problem(422, "MODEL_CONTENT_UNSUPPORTED");
    }
  const output = request.maxOutputTokens;
  if (
    output !== undefined &&
    (!Number.isInteger(output) ||
      output < 1 ||
      output > (engine.capabilities?.maxOutputTokens ?? 0))
  )
    throw new Problem(422, "MODEL_OUTPUT_LIMIT_UNSUPPORTED");
}
function schemaValidator(schema: Json) {
  try {
    if (
      typeof schema !== "boolean" &&
      (schema === null || typeof schema !== "object" || Array.isArray(schema))
    )
      throw new Error("invalid");
    if (JSON.stringify(schema).length > 16000) throw new Error("large");
    return compileJsonSchema(schema);
  } catch {
    throw new Problem(422, "MODEL_OUTPUT_SCHEMA_INVALID");
  }
}
export function validateModelTurn(
  request: ModelRequest,
  turn: ModelTurn,
): ModelTurn {
  if (request.outputSchema === undefined || turn.calls.length) return turn;
  try {
    const data: Json = JSON.parse(turn.text);
    if (!schemaValidator(request.outputSchema)(data))
      throw new Error("invalid");
    return { ...turn, data };
  } catch {
    throw new ExecutionFailure("permanent", "MODEL_OUTPUT_INVALID");
  }
}

/** 流式文本是临时展示数据，只有唯一的最终结果才能进入持久检查点。 */
export async function invokeModel(
  engine: ModelEngine,
  request: ModelRequest,
  tools: Tool[],
  signal: AbortSignal,
  context: import("../contracts/model-lifecycle.js").ModelCallContext,
  onText?: (text: string) => void,
): Promise<ModelTurn> {
  if (!request.stream) return engine.next(request, tools, signal, context);
  if (!engine.stream) throw new Problem(422, "MODEL_STREAM_UNSUPPORTED");
  let result: ModelTurn | undefined,
    bytes = 0;
  for await (const chunk of engine.stream(request, tools, signal, context)) {
    signal.throwIfAborted();
    if (result) throw new Problem(422, "MODEL_STREAM_INVALID");
    if (chunk.type === "result") result = chunk.value;
    else {
      if (chunk.text.length) context.progress?.();
      bytes += Buffer.byteLength(chunk.text);
      if (bytes > 1_000_000) throw new Problem(422, "MODEL_STREAM_TOO_LARGE");
      onText?.(chunk.text);
    }
  }
  if (!result) throw new Problem(422, "MODEL_STREAM_INCOMPLETE");
  return result;
}
