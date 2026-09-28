/** 稳定的平台协议；不依赖具体业务、数据库或模型 SDK。 */
import { z } from "zod";
export const JsonSchema = z.json();
export type Json = z.infer<typeof JsonSchema>;
export type Data = Record<string, Json>;
export const DataSchema = z.record(z.string(), JsonSchema);
export const TaskStatus = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting_external",
  "retry_scheduled",
  "succeeded",
  "failed",
  "cancelled",
]);
export type Status = z.infer<typeof TaskStatus>;
export const PrincipalRole = z.enum(["member", "admin", "superadmin"]);
export type Role = z.infer<typeof PrincipalRole>;
export type Principal = {
  id: string;
  workspace_id: string;
  capabilities: string[];
  enabled: boolean;
  role: Role;
};
export type Budget = {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxAttempts: number;
  maxDurationMs: number;
  maxCostUsd: number;
};
export const defaultBudget: Budget = {
  maxSteps: 40,
  maxModelCalls: 8,
  maxToolCalls: 16,
  maxAttempts: 4,
  maxDurationMs: 300_000,
  maxCostUsd: 1,
};
export type Task = {
  parent_id?: string | null;
  execution_scope?: string[] | null;
  trace_context?: { traceId: string; spanId: string; traceFlags: number };
  id: string;
  workspace_id: string;
  principal_id: string;
  conversation_id: string;
  module_id: string;
  module_version: string;
  config_hash: string;
  input: Data;
  status: Status;
  result: Json | null;
  error: string | null;
  budget: Budget;
  model_calls: number;
  tool_calls: number;
  cost_usd: number;
  execution_ms: number;
  lease_token: string | null;
  lease_until: Date | null;
  created_at: Date;
  run_id?: string;
};
export type Step = {
  id: string;
  task_id: string;
  key: string;
  kind: string;
  request: Action;
  output: Json | null;
  status: string;
  attempts: number;
};
export type ExecutionContext = {
  principal: Principal;
  taskId: string;
  runId: string;
  invocationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
};
export type Outcome =
  | { kind: "succeeded"; output: Json; receipt?: string }
  | {
      kind: "rejected" | "failed";
      code: string;
      message: string;
      category?: import("./failure.js").FailureCategory;
    }
  | {
      kind: "retryable";
      code: string;
      retryAfterMs?: number;
      category?: import("./failure.js").FailureCategory;
    }
  | { kind: "unknown"; reconciliationRef: string };
export type Tool = {
  name: string;
  version: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  capability: string;
  effect: "read" | "idempotent_write" | "reconcilable_write" | "unsafe_write";
  timeoutMs: number;
  approval?: boolean;
  execute(input: Data, context: ExecutionContext): Promise<Outcome>;
  reconcile?: (input: Data, context: ExecutionContext) => Promise<Outcome>;
};
export type ModelTurn = {
  data?: Json;
  text: string;
  calls: { id: string; name: string; arguments: Data }[];
  costUsd: number;
  costEstimated: boolean;
  inputTokens: number;
  outputTokens: number;
};
export type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "file"; id: string; mediaType: string };
export type ModelMessage = {
  content?: ModelContent[];
  role: "user" | "assistant" | "tool";
  text: string;
  callId?: string;
  toolName?: string;
  calls?: ModelTurn["calls"];
};
export type ReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ModelRequest = {
  stream?: boolean;
  contexts?: import("./context.js").ContextReference[];
  outputSchema?: Json;
  maxOutputTokens?: number;
  inputTokenBudget?: number;
  /** 单次模型调用上限；必须服从任务剩余总预算。 */
  timeoutMs?: number;
  firstOutputTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** 显式控制推理强度，避免将未传参数误认为已关闭推理。 */
  reasoning?: ReasoningLevel;
  /** 默认不请求 SDK 提示缓存；不保证供应商或网关禁用服务器缓存。 */
  cache?: "default" | "disabled";
  /** 可选检查点身份；跨重试复用前必须由模块提供稳定原文摘要。 */
  checkpoint?: { key: string; sourceDigest: string };
  instructions: string;
  messages: ModelMessage[];
  tools: string[];
};
export type Action =
  | {
      kind: "children";
      onFailure?: "fail" | "collect";
      key: string;
      children: { moduleId: string; input: Data }[];
    }
  | { kind: "tool"; key: string; name: string; input: Data }
  | { kind: "model"; key: string; request: ModelRequest }
  | {
      kind: "wait";
      key: string;
      reason: string;
      waitKind: "input" | "approval" | "external";
      schema: Json;
      expiresInMs: number;
      capability?: string;
    }
  | { kind: "complete"; result: Json; title?: string };
export type Module = {
  execution?: import("./execution.js").ProcessModule;
  id: string;
  version: string;
  title: string;
  description: string;
  capability: string;
  input: z.ZodType;
  example: Data;
  tools: Tool[];
  budget?: Partial<Budget>;
  /** 未声明时保守绑定全局配置；显式声明只绑定实际依赖，config 禁止放凭据。 */
  runtime?: {
    pool?: string;
    labels?: string[];
    modelProfile?: string;
    contexts?: string[];
    model: boolean;
    config?: Data;
    acceptLegacyProfile?: boolean;
  };
  next(input: Data, steps: Step[]): Action;
  validateContext?: (
    steps: Step[],
    principal: Principal,
    signal: AbortSignal,
  ) => Promise<void>;
  authorizeRead?: (
    task: Task,
    principal: Principal,
    signal: AbortSignal,
    steps: Step[],
  ) => Promise<void>;
};
export interface ModelEngine {
  lifecycle?: import("./model-lifecycle.js").ModelLifecyclePolicy;
  control?: import("./model-lifecycle.js").ModelControl;
  countTokens?: (request: ModelRequest, tools: Tool[]) => number;
  stream?: (
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
    context?: import("./model-lifecycle.js").ModelCallContext,
  ) => AsyncIterable<
    { type: "text"; text: string } | { type: "result"; value: ModelTurn }
  >;
  capabilities?: {
    progress?: boolean;
    modalities?: ("text" | "image" | "file")[];
    tools?: boolean;
    reasoning?: ReasoningLevel[];
    cache?: boolean;
    structuredOutput: "validated" | "native";
    maxOutputTokens: number;
  };
  id: string;
  close?: () => Promise<void>;
  next(
    request: ModelRequest,
    tools: Tool[],
    signal: AbortSignal,
    context?: import("./model-lifecycle.js").ModelCallContext,
  ): Promise<ModelTurn>;
}
export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
/** 相同动作必须由相同的规范化 JSON 定义；对象键顺序不影响指纹。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function hasCapability(
  principal: Principal,
  capability: string,
): boolean {
  return principal.enabled && principal.capabilities.includes(capability);
}
export function requireCapability(
  principal: Principal,
  capability: string,
): void {
  if (!hasCapability(principal, capability))
    throw new Problem(403, "FORBIDDEN");
}

export type {
  ModelInvocation,
  ModelCallContext,
  ModelReceipt,
  ModelControl,
  ModelLifecyclePolicy,
} from "./model-lifecycle.js";
