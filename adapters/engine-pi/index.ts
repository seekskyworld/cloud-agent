import {
  ExecutionFailure,
  retryAfter,
} from "../../packages/contracts/failure.js";
/** Pi 只执行一轮模型请求；工具与检查点由平台持有，SDK 私有类型不出适配层。 */
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import type { Message, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import {
  DataSchema,
  Problem,
  type ModelEngine,
  type ModelMessage,
  type ModelRequest,
  type ModelTurn,
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
const wireName = (name: string) => `t_${Buffer.from(name).toString("hex")}`;
export class PiEngine implements ModelEngine {
  readonly capabilities: NonNullable<ModelEngine["capabilities"]>;
  readonly id: string;
  private model: Model<"openai-completions">;
  constructor(
    private config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      inputPrice: number;
      outputPrice: number;
      reasoning?: boolean;
    },
  ) {
    this.capabilities = {
      structuredOutput: "validated",
      maxOutputTokens: 2048,
      reasoning: config.reasoning
        ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        : ["none"],
      cache: true,
    };
    this.id = `pi:0.85.1:${config.model}`;
    this.model = {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "openai",
      baseUrl: config.baseUrl,
      reasoning: config.reasoning ?? false,
      input: ["text"],
      cost: {
        input: config.inputPrice,
        output: config.outputPrice,
        cacheRead: config.inputPrice,
        cacheWrite: config.inputPrice,
      },
      contextWindow: 32000,
      maxTokens: 2048,
    };
  }
  private message(message: ModelMessage): Message {
    if (message.content?.some((part) => part.type !== "text"))
      throw new Problem(422, "MODEL_MODALITY_UNSUPPORTED");
    message = {
      ...message,
      text: [
        message.text,
        ...(message.content ?? []).flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    };
    if (message.role === "user")
      return { role: "user", content: message.text, timestamp: 0 };
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
  async next(
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    // 请求有明确字符上限，避免无限会话和工具输出挤占上下文。
    if (JSON.stringify(request).length > 80_000)
      throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
    let httpFailure: ExecutionFailure | undefined;
    const output = await completions(
      this.model,
      {
        systemPrompt: request.instructions,
        messages: request.messages.map((message) => this.message(message)),
        tools: tools.map((tool) => ({
          name: wireName(tool.name),
          description: tool.description,
          parameters: Type.Unsafe(z.toJSONSchema(tool.input)),
        })),
      },
      {
        apiKey: this.config.apiKey,
        signal,
        timeoutMs: request.timeoutMs,
        maxTokens: request.maxOutputTokens ?? 2048,
        reasoning: request.reasoning === "none" ? undefined : request.reasoning,
        cacheRetention: request.cache === "default" ? undefined : "none",
        maxRetries: 0,
        // OpenAI 兼容网关对缺省字段和显式空数组的处理可能不同；在适配器边界固定请求语义。
        onPayload: (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return payload;
          const body = { ...(payload as Record<string, unknown>) };
          body.tools = Array.isArray(body.tools) ? body.tools : [];
          body.reasoning_effort = request.reasoning ?? "none";
          if (request.cache === "disabled" || request.cache === undefined) {
            delete body.prompt_cache_key;
            delete body.prompt_cache_retention;
          }
          return body;
        },
        // SDK 将 HTTP 异常转成流结束事件；在传输边界保留状态，避免依赖可能含秘密的错误正文。
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok)
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
                retryAfterMs:
                  response.status === 504
                    ? Math.max(
                        5_000,
                        retryAfter(response.headers.get("retry-after")) ?? 0,
                      )
                    : retryAfter(response.headers.get("retry-after")),
              },
            );
          return response;
        },
      },
    ).result();
    if (httpFailure) throw httpFailure;
    if (!["stop", "toolUse"].includes(output.stopReason))
      throw new Problem(502, "MODEL_INCOMPLETE");
    const calls = output.content
      .filter((part) => part.type === "toolCall")
      .map((part) => {
        const tool = tools.find((tool) => wireName(tool.name) === part.name);
        if (!tool) throw new Problem(403, "MODEL_TOOL_NOT_ALLOWED");
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
    };
  }
}
/** 无密钥示例只回显输入并明确标识；不伪装成真实的模型生成结果。 */
export class DemoEngine implements ModelEngine {
  readonly id = "demo:echo-v1";
  async next(request: ModelRequest): Promise<ModelTurn> {
    return {
      text: `本地演示（未调用模型）：\n${request.messages.map((message) => message.text).join("\n")}`,
      calls: [],
      costUsd: 0,
      costEstimated: false,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
