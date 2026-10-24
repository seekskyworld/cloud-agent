import { inputReceipt } from "./input-receipt.js";
import { fingerprint } from "../../packages/contracts/fingerprint.js";
import {
  gatewayControl,
  managedHeaders,
  verifyManagedResponse,
  type ManagedGateway,
} from "./control.js";
import type {
  ModelCallContext,
  ModelLifecyclePolicy,
  ModelControl,
} from "../../packages/contracts/model-lifecycle.js";
import type { ReasoningLevel } from "../../packages/contracts/index.js";
import {
  ExecutionFailure,
  retryAfter,
} from "../../packages/contracts/failure.js";
/** Pi 只执行一轮模型请求；工具与检查点由平台持有，SDK 私有类型不出适配层。 */
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type {
  Message,
  Model,
  Usage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import {
  DataSchema,
  Problem,
  type ModelEngine,
  type ModelMessage,
  type ModelRequest,
  type ModelTurn,
  type Json,
  type Tool,
} from "../../packages/contracts/index.js";
const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** 提示缓存命中只作为用量事实回报；费用估算口径不变。 */
const cacheUsage = (usage: Usage) => ({
  cacheReadTokens: usage.cacheRead,
  cacheWriteTokens: usage.cacheWrite,
});
const wireName = (name: string) => `t_${Buffer.from(name).toString("hex")}`;
const optionalCapacity = (name: string, value: number | undefined) =>
  value === undefined ? {} : { [name]: value };
type PiModel =
  | Model<"openai-completions">
  | Model<"openai-responses">
  | Model<"anthropic-messages">;

function adaptiveModel(model: PiModel): model is Model<"anthropic-messages"> {
  return (
    model.api === "anthropic-messages" &&
    /claude-(?:opus|sonnet)-(?:4-[6-9]|[5-9])/.test(model.id)
  );
}
function decoratePayload(
  payload: unknown,
  model: PiModel,
  request: ModelRequest,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const body = { ...(payload as Record<string, unknown>) };
  body.tools = Array.isArray(body.tools) ? body.tools : [];
  if (model.api === "openai-completions")
    body.reasoning_effort = request.reasoning ?? "none";
  else if (
    model.api === "openai-responses" &&
    request.reasoning &&
    request.reasoning !== "none"
  )
    body.reasoning = { effort: request.reasoning };
  if (request.cache === "disabled" || request.cache === undefined) {
    delete body.prompt_cache_key;
    delete body.prompt_cache_retention;
  }
  return body;
}

function streamForModel(
  model: PiModel,
  context: Parameters<typeof completions>[1],
  options: SimpleStreamOptions,
) {
  if (model.api === "openai-responses")
    return responses(model, context, options);
  if (model.api === "anthropic-messages")
    return anthropic(model, context, options);
  return completions(model, context, options);
}

export class PiEngine implements ModelEngine {
  static readonly compatibility = "pi:1.3.0:lifecycle-v8-max-effort";
  readonly capabilities: NonNullable<ModelEngine["capabilities"]>;
  readonly id: string;
  readonly lifecycle: ModelLifecyclePolicy;
  readonly control?: ModelControl;
  private model: PiModel;
  constructor(
    private config: {
      protocol?: "completions" | "responses" | "anthropic";
      baseUrl: string;
      apiKey: string;
      model: string;
      inputPrice: number;
      outputPrice: number;
      vision?: boolean;
      video?: boolean;
      maxOutputTokens?: number;
      contextWindow?: number;
      reasoning?: boolean;
      reasoningLevels?: ReasoningLevel[];
      lifecycle?: ModelLifecyclePolicy;
      managed?: ManagedGateway;
    },
  ) {
    this.capabilities = {
      progress: true,
      structuredOutput: "validated",
      maxOutputTokens: config.maxOutputTokens ?? 8192,
      reasoning: config.reasoningLevels ?? ["none"],
      cache: true,
      modalities:
        config.vision === false
          ? ["text"]
          : config.video === false
            ? ["text", "image"]
            : ["text", "image", "video"],
    };
    // SDK 协议实现参与恢复指纹；升级后由兼容旧 Worker 排空已有模型任务。
    this.id = `${PiEngine.compatibility}:${config.model}:${fingerprint({ protocol: config.protocol ?? "completions", baseUrl: config.baseUrl, managed: config.managed, reasoningLevels: config.reasoningLevels, ...optionalCapacity("maxOutputTokens", config.maxOutputTokens), ...optionalCapacity("contextWindow", config.contextWindow) })}`;
    this.lifecycle = config.lifecycle ?? {
      resourceId: `pi:${fingerprint(config.baseUrl)}`,
      // Anthropic tool rounds can emit an extended thinking block before the
      // first visible token. Keep the normal gateway timeout for other Pi
      // protocols, while allowing Claude tool planning enough time to produce
      // a complete call instead of being recorded as an unknown result.
      firstOutputTimeoutMs: config.protocol === "anthropic" ? 180000 : 90000,
      idleTimeoutMs: config.protocol === "anthropic" ? 180000 : 60000,
    };
    if (config.managed)
      this.control = gatewayControl(async () => config, config.managed);
    this.model = {
      id: config.model,
      name: config.model,
      api:
        config.protocol === "responses"
          ? "openai-responses"
          : config.protocol === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
      provider: config.protocol === "anthropic" ? "anthropic" : "openai",
      baseUrl: config.baseUrl,
      reasoning:
        config.reasoningLevels?.some((v) => v !== "none") ??
        config.reasoning ??
        false,
      input: config.vision === false ? ["text"] : ["text", "image"],
      cost: {
        input: config.inputPrice,
        output: config.outputPrice,
        cacheRead: config.inputPrice,
        cacheWrite: config.inputPrice,
      },
      // 网关模型容量由部署配置声明；未知时交由服务端校验，不能伪造
      // 32K 容量让 SDK 在多图输入后把 max_tokens 静默压为 1。
      contextWindow: config.contextWindow ?? 0,
      maxTokens: config.maxOutputTokens ?? 8192,
    };
    if (adaptiveModel(this.model)) {
      this.model.compat = { forceAdaptiveThinking: true };
      // Pi 对未映射的 max 默认退回 high，必须显式声明供应商等级。
      this.model.thinkingLevelMap = { max: "max" };
    }
  }
  private message(message: ModelMessage): Message {
    const content = [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...(message.content ?? [])
        .map((part) =>
          part.type === "image"
            ? [
                {
                  type: "image" as const,
                  data: part.data,
                  mimeType: part.mediaType,
                },
              ]
            : part.type === "video"
              ? [
                  {
                    type: "text" as const,
                    text: `视频附件（${part.mediaType}，${part.frames.length} 帧${part.durationSeconds === undefined ? "" : `，时长 ${part.durationSeconds.toFixed(1)} 秒`}）已展开为按时间排序的视觉帧。请结合整段帧序列判断动作、连续性和节奏。`,
                  },
                  ...part.frames.flatMap((frame) => [
                    {
                      type: "text" as const,
                      text: `视频时间 ${frame.timestampSeconds.toFixed(3)} 秒`,
                    },
                    {
                      type: "image" as const,
                      data: frame.data,
                      mimeType: frame.mediaType,
                    },
                  ]),
                ]
              : part.type === "text"
                ? [{ type: "text" as const, text: part.text }]
                : [{ type: "text" as const, text: `[file:${part.id}]` }],
        )
        .flat(),
    ];
    message = {
      ...message,
      text: content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    };
    if (message.role === "user")
      return { role: "user", content, timestamp: 0 } as Message;
    if (message.role === "tool")
      return {
        role: "toolResult",
        toolCallId: message.callId!,
        toolName: wireName(message.toolName!),
        content: [{ type: "text", text: message.text }],
        isError: false,
        timestamp: 0,
      };
    return {
      role: "assistant",
      content: [
        ...(message.text
          ? [{ type: "text" as const, text: message.text }]
          : []),
        ...(message.calls ?? []).map((call) => ({
          type: "toolCall" as const,
          id: call.id,
          name: wireName(call.name),
          arguments: call.arguments,
        })),
      ],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: emptyUsage,
      stopReason: message.calls?.length ? "toolUse" : "stop",
      timestamp: 0,
    };
  }
  private openStream(
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
    context?: ModelCallContext,
  ) {
    // 图片 Base64 是传输载荷，不是文本 token。分别限制文本与媒体字节，
    // 避免正常的多帧视频观察被 80 KB 文本保护误拒绝。
    const textRequest = {
      ...request,
      messages: request.messages.map((message) => ({
        ...message,
        content: message.content?.map((part) =>
          part.type === "image"
            ? { ...part, data: "" }
            : part.type === "video"
              ? {
                  ...part,
                  frames: part.frames.map((frame) => ({ ...frame, data: "" })),
                }
              : part,
        ),
      })),
    };
    if (
      JSON.stringify(textRequest).length > 600_000 ||
      JSON.stringify(request).length > 20_000_000
    )
      throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
    let httpFailure: ExecutionFailure | undefined;
    let receipt: Json = { status: "not_captured" };
    if (this.config.managed && !context?.invocation)
      throw new Problem(422, "MODEL_INVOCATION_REQUIRED");
    // Pi 1.x 将系统指令和工具声明编码到 transcript，不能仅靠类型断言适配。
    const modelContext = normalizeContext({
      systemPrompt: request.instructions,
      messages: request.messages.map((message) => this.message(message)),
      tools: tools.map((tool) => ({
        name: wireName(tool.name),
        description: tool.description,
        parameters: Type.Unsafe(z.toJSONSchema(tool.input)),
      })),
    });
    const streamOptions: SimpleStreamOptions = {
      apiKey: this.config.apiKey,
      headers:
        this.config.managed && context?.invocation
          ? managedHeaders(this.config.managed, context.invocation)
          : undefined,
      signal,
      timeoutMs: request.timeoutMs,
      maxTokens: request.maxOutputTokens ?? 2048,
      // SDK 将 HTTP 异常转成流结束事件；在传输边界保留状态，避免依赖可能含秘密的错误正文。
      reasoning: request.reasoning === "none" ? undefined : request.reasoning,
      cacheRetention: request.cache === "default" ? undefined : "none",
      maxRetries: 0,
      // OpenAI 兼容网关对缺省字段和显式空数组的处理可能不同；在适配器边界固定请求语义。
      onPayload: (payload) => decoratePayload(payload, this.model, request),
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, redirect: "error" });
        if (typeof init?.body === "string")
          receipt = inputReceipt(request, init.body, response.ok);
        if (this.config.managed && context?.invocation)
          verifyManagedResponse(response, context.invocation.id);
        if (!response.ok) {
          console.warn(
            JSON.stringify({
              event: "model.http_rejected",
              status: response.status,
              protocol: this.config.protocol ?? "completions",
            }),
          );
          httpFailure = new ExecutionFailure(
            response.status === 429
              ? "rate_limited"
              : [401, 403].includes(response.status)
                ? "authorization"
                : [408, 425].includes(response.status)
                  ? "transient"
                  : response.status < 500
                    ? "permanent"
                    : "transient",
            response.status === 408 || response.status === 425
              ? "MODEL_QUEUE_TIMEOUT"
              : response.status === 504
                ? "MODEL_EXECUTION_TIMEOUT"
                : "MODEL_HTTP_REJECTED",
            {
              notAccepted: response.status === 413,
              retryAfterMs:
                response.status === 504
                  ? Math.max(
                      5_000,
                      retryAfter(response.headers.get("retry-after")) ?? 0,
                    )
                  : retryAfter(response.headers.get("retry-after")),
            },
          );
        }
        return response;
      },
    };
    return {
      stream: streamForModel(this.model, modelContext, streamOptions),
      httpFailure: () => httpFailure,
      receipt: () => receipt,
    };
  }
  private outputTurn(
    output: Awaited<ReturnType<ReturnType<typeof completions>["result"]>>,
    request: ModelRequest,
    tools: Tool[],
  ): ModelTurn {
    // 供应商明确拒绝属于终态，不能当断流反复重试，也不能执行拒绝前的部分工具请求。
    if (providerRefused(output))
      throw new ExecutionFailure("permanent", "MODEL_PROVIDER_REFUSAL");
    if (
      output.usage.output > (request.maxOutputTokens ?? 2048) &&
      (request.reasoning ?? "none") === "none"
    )
      throw new ExecutionFailure("permanent", "MODEL_OUTPUT_LIMIT");
    if (output.stopReason === "length") {
      if (!tools.length || output.usage.output <= 1)
        throw new ExecutionFailure("permanent", "MODEL_OUTPUT_LIMIT");
      // 截断的工具参数不可执行。保留已计费用量，把续写事实交给编排器；
      // 适配器不自行再请求、不提高预算，也不执行部分解析成功的写操作。
      return {
        text: "本轮输出达到长度上限，所有未完成的工具请求均未执行。接下来根据输出容量分批处理，按需保存简洁项目检查点，再按原目标继续，不重复已经完成的动作。",
        data: {
          incomplete: true,
          reason: "output_limit",
          discardedToolCalls: true,
        },
        calls: [],
        costUsd: output.usage.cost.total,
        costEstimated: true,
        inputTokens: output.usage.input,
        outputTokens: output.usage.output,
        ...cacheUsage(output.usage),
      };
    }
    if (!["stop", "toolUse"].includes(output.stopReason))
      throw new Problem(502, "MODEL_INCOMPLETE");
    const requestedCalls = output.content.filter(
      (part) => part.type === "toolCall",
    );
    if (
      request.maxToolCalls !== undefined &&
      requestedCalls.length > request.maxToolCalls
    ) {
      return {
        text: `本轮工具批次超过容量（${requestedCalls.length}/${request.maxToolCalls}），整批未执行。下一轮只提出一个最小操作。`,
        data: {
          incomplete: true,
          reason: "tool_batch_limit",
          discardedToolCalls: true,
        },
        calls: [],
        costUsd: output.usage.cost.total,
        costEstimated: true,
        inputTokens: output.usage.input,
        outputTokens: output.usage.output,
        ...cacheUsage(output.usage),
      };
    }
    const advertisedTool = (name: string) =>
      tools.find((tool) => wireName(tool.name) === name || tool.name === name);
    const unknown = requestedCalls.filter((part) => !advertisedTool(part.name));
    if (unknown.length) {
      // 模型提出工具不等于获准执行。整批未调度，保留用量与错误事实供
      // 编排器下一轮纠正；不猜测近似名称，不自动执行同批的其他写操作。
      return {
        text: `本轮包含未列出的工具名：${unknown.map((part) => part.name.slice(0, 200)).join("、")}。本轮所有工具调用均未提交或执行。请使用当前工具列表中的准确名称重新提出请求，不重复此前已完成的步骤。`,
        data: {
          incomplete: true,
          reason: "unrecognized_tool",
          discardedToolCalls: true,
          unrecognizedTools: unknown.map((part) => part.name.slice(0, 200)),
        },
        calls: [],
        costUsd: output.usage.cost.total,
        costEstimated: true,
        inputTokens: output.usage.input,
        outputTokens: output.usage.output,
        ...cacheUsage(output.usage),
      };
    }
    // Pi 1.3 起，参数文本不是合法 JSON 对象时 arguments 为 {} 并给出 argumentsError；
    // 不能把空参数当作模型意图执行。整批不执行，把原文与原因交给模型改正。
    const malformed = requestedCalls.filter((part) => part.argumentsError);
    if (malformed.length)
      return {
        text: `本轮有工具调用的参数不是合法 JSON：${malformed.map((part) => `${advertisedTool(part.name)?.name ?? part.name.slice(0, 200)}：${String(part.argumentsError).slice(0, 600)}`).join("；")}。本轮所有工具调用均未提交或执行，请用合法 JSON 重新提出。`,
        data: {
          incomplete: true,
          reason: "tool_arguments_invalid",
          discardedToolCalls: true,
        },
        calls: [],
        costUsd: output.usage.cost.total,
        costEstimated: true,
        inputTokens: output.usage.input,
        outputTokens: output.usage.output,
        ...cacheUsage(output.usage),
      };
    const calls = requestedCalls.map((part) => {
      const tool = advertisedTool(part.name)!;
      return {
        id: part.id,
        name: tool.name,
        arguments: DataSchema.parse(part.arguments),
      };
    });
    return {
      text: output.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      calls,
      costUsd: output.usage.cost.total,
      costEstimated: true,
      inputTokens: output.usage.input,
      outputTokens: output.usage.output,
      ...cacheUsage(output.usage),
    };
  }
  async next(
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
    context?: ModelCallContext,
  ): Promise<ModelTurn> {
    const opened = this.openStream(request, tools, signal, context);
    const stream = opened.stream;
    const output = await consumeModelStream(stream, signal, context?.progress);
    if (opened.httpFailure()) throw opened.httpFailure();
    await reportUsage(output, context);
    return attachReceipt(
      this.outputTurn(output, request, tools),
      opened.receipt(),
    );
  }
  async *stream(
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
    context?: ModelCallContext,
  ): AsyncIterable<
    { type: "text"; text: string } | { type: "result"; value: ModelTurn }
  > {
    const opened = this.openStream(request, tools, signal, context);
    const progress = streamProgress(context?.progress);
    for await (const event of opened.stream) {
      signal.throwIfAborted();
      progress(event);
      if (
        event.type === "text_delta" &&
        typeof event.delta === "string" &&
        event.delta.length
      )
        yield { type: "text", text: event.delta };
    }
    const output = await opened.stream.result();
    if (opened.httpFailure()) throw opened.httpFailure();
    await reportUsage(output, context);
    yield {
      type: "result",
      value: attachReceipt(
        this.outputTurn(output, request, tools),
        opened.receipt(),
      ),
    };
  }
}
/** 无密钥示例只回显输入并明确标识；不伪装成真实的模型生成结果。 */
export class DemoEngine implements ModelEngine {
  readonly id = "demo:echo-v1";
  async next(request: ModelRequest): Promise<ModelTurn> {
    return this.turn(request);
  }
  private turn(request: ModelRequest): ModelTurn {
    return {
      text: `本地演示（未调用模型）：\n${request.messages.map((message) => message.text).join("\n")}`,
      calls: [],
      costUsd: 0,
      costEstimated: false,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  async *stream(
    request: ModelRequest,
  ): AsyncIterable<
    { type: "text"; text: string } | { type: "result"; value: ModelTurn }
  > {
    const value = this.turn(request);
    yield { type: "text", text: value.text };
    yield { type: "result", value };
  }
}

async function consumeModelStream(
  stream: ReturnType<typeof completions>,
  signal: AbortSignal,
  progress?: () => void,
) {
  const track = streamProgress(progress);
  for await (const event of stream) {
    signal.throwIfAborted();
    track(event);
  }
  return stream.result();
}

/** Valid reasoning/tool deltas advance liveness without exposing reasoning in the UI. */
function streamProgress(progress?: () => void) {
  let bytes = 0;
  return (event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      "delta" in event &&
      typeof event.delta === "string" &&
      event.delta.length
    ) {
      progress?.();
      bytes += Buffer.byteLength(event.delta);
      if (bytes > 1_000_000)
        throw new ExecutionFailure("permanent", "MODEL_OUTPUT_LIMIT");
    }
  };
}

/** 原始终止码来自供应商协议；普通SDK错误或本地取消不能冒充明确拒绝。 */
function providerRefused(output: {
  stopReason: string;
  rawStopReason?: string;
}) {
  return (
    output.stopReason !== "aborted" &&
    ["refusal", "sensitive"].includes(output.rawStopReason ?? "")
  );
}

/** 完整终态与业务输出是否合格分开；中断时观测到的用量只作为部分值。 */
async function reportUsage(
  output: Awaited<ReturnType<ReturnType<typeof completions>["result"]>>,
  context?: ModelCallContext,
) {
  const complete = ["stop", "toolUse", "length"].includes(output.stopReason);
  if (complete || providerRefused(output) || output.usage.totalTokens > 0)
    await context?.report?.({
      state: complete || providerRefused(output) ? "completed" : "unknown",
      usage: { costUsd: output.usage.cost.total, estimated: true, complete },
    });
}

function attachReceipt(turn: ModelTurn, receipt: Json): ModelTurn {
  const data =
    turn.data && typeof turn.data === "object" && !Array.isArray(turn.data)
      ? turn.data
      : {};
  return { ...turn, data: { ...data, inputReceipt: receipt } };
}
