import { CostResolution, JobChange } from "../contracts/governance.js";
import { AccessChange } from "../contracts/administration.js";
/** 扩展公开 API 契约；复杂供应商状态保留 JSON 形状，写操作仍使用明确输入协议。 */
import { z } from "zod";
import { Create, DetailSchema, TaskSummarySchema } from "./contracts.js";
import { DataSchema } from "../contracts/index.js";
const empty = z.undefined(),
  ok = z.object({ ok: z.literal(true) }),
  json = z.json();
const route = <B extends z.ZodType, R extends z.ZodType>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: B,
  response: R,
  key = false,
) => ({ method, path, body, response, key });
const token = z.object({
  id: z.uuid(),
  name: z.string(),
  expires_at: z.string(),
  revoked_at: z.string().nullable().optional(),
});
export const MailCommand = z
  .object({
    action: z.enum(["resume", "retry", "resolve", "reset-cursor"]),
    target: z.string().min(1).max(1000),
    reason: z.string().trim().min(1).max(500),
    resolution: z.enum(["sent", "cancelled"]).optional(),
    providerId: z.string().min(1).max(1000).optional(),
  })
  .strict();
export const ChannelCommand = z
  .object({
    target: z.uuid(),
    resolution: z.enum(["sent", "cancelled"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const managementEndpoints = {
  changePrincipal: route("POST", "/admin/principals", AccessChange, json, true),
  mailCommand: route("POST", "/admin/mail/{id}/commands", MailCommand, ok),
  legacyMailCommand: route("POST", "/admin/mail/commands", MailCommand, ok),
  channelCommand: route(
    "POST",
    "/admin/channels/{id}/commands",
    ChannelCommand,
    ok,
  ),
  deployment: route("GET", "/deployment", empty, json),
  conversations: route(
    "GET",
    "/conversations",
    empty,
    z.array(
      z.object({ id: z.uuid(), title: z.string(), created_at: z.string() }),
    ),
  ),
  messages: route(
    "GET",
    "/conversations/{id}/messages",
    empty,
    z.array(
      z.object({
        id: z.union([z.string(), z.number()]),
        task_id: z.uuid(),
        role: z.string(),
        content: json,
        created_at: z.string(),
      }),
    ),
  ),
  schedules: route(
    "GET",
    "/schedules",
    empty,
    z.array(
      z.object({
        id: z.uuid(),
        module_id: z.string(),
        input: DataSchema,
        interval_seconds: z.number(),
        next_at: z.string(),
        enabled: z.boolean(),
      }),
    ),
  ),
  createSchedule: route(
    "POST",
    "/schedules",
    Create.omit({ conversationId: true }).extend({
      intervalSeconds: z.number().int().min(60).max(31536000),
    }),
    json,
  ),
  deleteSchedule: route("DELETE", "/schedules/{id}", empty, ok),
  tokens: route("GET", "/tokens", empty, z.array(token)),
  createToken: route(
    "POST",
    "/tokens",
    z
      .object({
        name: z.string().min(1).max(100),
        days: z.number().int().min(1).max(365),
      })
      .strict(),
    token.extend({ token: z.string() }),
  ),
  revokeToken: route("DELETE", "/tokens/{id}", empty, ok),
  grantDelegation: route(
    "POST",
    "/tasks/{id}/delegations",
    z
      .object({
        delegate: z.string().min(1),
        actions: z.array(z.enum(["read", "approve"])).min(1),
        hours: z.number().int().min(1).max(168),
        reason: z.string().min(1).max(1000),
      })
      .strict(),
    z.object({ id: z.uuid() }),
  ),
  revokeDelegation: route("DELETE", "/delegations/{id}", empty, ok),
  delegatedDetail: route("GET", "/delegated/tasks/{id}", empty, DetailSchema),
  delegatedApproval: route(
    "POST",
    "/delegated/tasks/{id}/approval",
    z.object({ waitId: z.uuid(), approved: z.boolean() }).strict(),
    ok,
    true,
  ),
  taskPage: route(
    "GET",
    "/task-page",
    empty,
    z.object({
      items: z.array(TaskSummarySchema),
      next: z.string().nullable(),
    }),
  ),
  business: route("GET", "/business", empty, json),
  operations: route("GET", "/operations", empty, json),
  pendingCosts: route("GET", "/costs/pending", empty, json),
  resolveCost: route("POST", "/costs/resolve", CostResolution, ok, true),
  businessJobs: route("GET", "/business-jobs", empty, json),
  changeBusinessJob: route("POST", "/business-jobs", JobChange, ok, true),
  costs: route("GET", "/costs", empty, json),
  adminCatalog: route("GET", "/admin/catalog", empty, json),
  adminPrincipals: route("GET", "/admin/principals", empty, json),
  adminAudit: route("GET", "/admin/audit", empty, json),
  adminMail: route("GET", "/admin/mail", empty, json),
  adminChannels: route("GET", "/admin/channels", empty, json),
  memories: route(
    "POST",
    "/memories",
    z
      .object({
        namespace: z.string(),
        content: z.string(),
        days: z.number().int(),
      })
      .strict(),
    z.object({ id: z.uuid() }),
    true,
  ),
  removeMemory: route(
    "DELETE",
    "/memories/{id}",
    empty,
    z.object({ removed: z.boolean() }),
  ),
};
