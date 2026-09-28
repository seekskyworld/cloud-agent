/** 核心任务 API 的请求、响应与文档共用此契约；可在浏览器使用，无数据库依赖。 */
import { z } from "zod";
import {
  DataSchema,
  JsonSchema,
  TaskStatus,
  PrincipalRole,
} from "../contracts/index.js";
import { Reconciliation } from "./reconciliation.js";
export const Key = z.string().min(1).max(180);
export const Id = z.object({ id: z.uuid() });
export const Create = z
  .object({
    moduleId: z.string().min(1).max(80),
    input: DataSchema,
    conversationId: z.uuid().optional(),
  })
  .strict();
export const Response = z.object({ response: DataSchema }).strict();
export const InputResponse = Response.extend({ waitId: z.uuid() });
export const Signal = z
  .object({ waitKey: z.string().min(1).max(120), response: DataSchema })
  .strict();
const Schema = z.record(z.string(), JsonSchema);
const Timestamp = z.string();
export const AgentSchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  example: DataSchema,
  inputSchema: Schema,
});
export const TaskSummarySchema = z.object({
  id: z.uuid(),
  module_id: z.string(),
  status: TaskStatus,
  created_at: Timestamp,
  error: z.string().nullable(),
  available: z.boolean().optional(),
  compatibility: z.string().optional(),
});
export const FileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  media_type: z.string(),
  bytes: z.number(),
  digest: z.string(),
});
export const DetailSchema = z.object({
  task: TaskSummarySchema.extend({
    input: DataSchema,
    result: JsonSchema.nullable(),
    conversation_id: z.uuid(),
    model_calls: z.number(),
    tool_calls: z.number(),
    cost_usd: z.union([z.string(), z.number()]),
  }),
  steps: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      kind: z.string(),
      status: z.string(),
      attempts: z.number(),
      output: JsonSchema.nullable(),
    }),
  ),
  waits: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      reason: z.string(),
      status: z.string(),
      schema: Schema,
    }),
  ),
  artifacts: z.array(z.object({ id: z.uuid(), title: z.string() })),
  invocations: z.array(
    z.object({
      id: z.uuid(),
      tool_name: z.string(),
      status: z.string(),
      receipt: z.string().nullable(),
    }),
  ),
  files: z.array(FileSchema),
});
export const MeSchema = z.object({
  authMode: z.enum(["none", "token"]),
  principal: z.object({
    id: z.string(),
    workspace_id: z.string(),
    capabilities: z.array(z.string()),
    enabled: z.boolean(),
    role: PrincipalRole,
  }),
  administration: z.array(z.string()),
  engine: z.string(),
});
const Ok = z.object({ ok: z.literal(true) });
export interface Endpoint<B extends z.ZodType, R extends z.ZodType> {
  method: "GET" | "POST";
  path: string;
  body: B;
  response: R;
  key?: boolean;
  status?: number;
}
const endpoint = <B extends z.ZodType, R extends z.ZodType>(
  value: Endpoint<B, R>,
) => value;
export const endpoints = {
  me: endpoint({
    method: "GET",
    path: "/me",
    body: z.undefined(),
    response: MeSchema,
  }),
  agents: endpoint({
    method: "GET",
    path: "/agents",
    body: z.undefined(),
    response: z.array(AgentSchema),
  }),
  tasks: endpoint({
    method: "GET",
    path: "/tasks",
    body: z.undefined(),
    response: z.array(TaskSummarySchema),
  }),
  create: endpoint({
    method: "POST",
    path: "/tasks",
    body: Create,
    response: z.object({
      id: z.uuid(),
      status: TaskStatus,
      conversationId: z.uuid(),
    }),
    key: true,
    status: 202,
  }),
  detail: endpoint({
    method: "GET",
    path: "/tasks/{id}",
    body: z.undefined(),
    response: DetailSchema,
  }),
  cancel: endpoint({
    method: "POST",
    path: "/tasks/{id}/cancel",
    body: z.object({}).strict(),
    response: Ok,
  }),
  retry: endpoint({
    method: "POST",
    path: "/tasks/{id}/retry",
    body: z.object({}).strict(),
    response: Ok,
  }),
  respond: endpoint({
    method: "POST",
    path: "/tasks/{id}/inputs",
    body: InputResponse,
    response: Ok,
    key: true,
  }),
  decide: endpoint({
    method: "POST",
    path: "/waits/{id}/decisions",
    body: Response,
    response: Ok,
    key: true,
  }),
  signal: endpoint({
    method: "POST",
    path: "/tasks/{id}/signals",
    body: Signal,
    response: Ok,
    key: true,
  }),
  reconcile: endpoint({
    method: "POST",
    path: "/tasks/{id}/reconciliation",
    body: Reconciliation,
    response: Ok,
    key: true,
  }),
  artifact: endpoint({
    method: "GET",
    path: "/artifacts/{id}",
    body: z.undefined(),
    response: z.object({
      task_id: z.uuid(),
      title: z.string(),
      content: JsonSchema,
      media_type: z.string(),
    }),
  }),
  events: endpoint({
    method: "GET",
    path: "/tasks/{id}/events",
    body: z.undefined(),
    response: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        data: JsonSchema,
        created_at: Timestamp,
      }),
    ),
  }),
} as const;
export type Agent = z.infer<typeof AgentSchema>;
export type Detail = z.infer<typeof DetailSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type Me = z.infer<typeof MeSchema>;
