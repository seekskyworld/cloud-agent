/** 完整业务应用的贡献协议；宿主注入可信身份、截止信号与请求键。 */
import type { BusinessCheck } from "./checks.js";
import type { z } from "zod";
import type { Data, Json, Module, Principal } from "../contracts/index.js";
export interface BusinessRoute {
  id: string;
  method: "GET" | "POST";
  capability: string;
  input: z.ZodType;
  output: z.ZodType;
  /** POST 必须使用 key 实现领域幂等，框架不会自动重发。 */
  handle(
    input: unknown,
    context: { principal: Principal; key?: string; signal: AbortSignal },
  ): Promise<Json>;
}
/** 业务文件内容：平台负责 Range、inline/attachment 与安全响应头。 */
export interface BusinessFile {
  name: string;
  mediaType: string;
  data: Uint8Array;
}
/**
 * 业务文件路由（/business/<包>/files/<id>）：GET 读取业务自己存储里的文件（视频可拖动进度、断点续传）；
 * PUT 接收原始字节（application/octet-stream），必须带 Idempotency-Key，由业务实现领域幂等。
 * 查询参数 inline=true 时以内联方式返回（浏览器内预览），否则作为附件下载；inline 不进入 input。
 */
export interface BusinessFileRoute {
  id: string;
  method: "GET" | "PUT";
  capability: string;
  /** 查询参数（不含 inline）。 */
  input: z.ZodType;
  /** PUT 的返回结构；GET 返回文件。 */
  output?: z.ZodType;
  /** PUT 请求体上限（字节），默认 50 MB，最大 500 MB。 */
  maxBytes?: number;
  /** 每分钟每个来源的请求上限；不写时用平台默认。 */
  ratePerMinute?: number;
  handle(
    input: unknown,
    context: {
      principal: Principal;
      key?: string;
      body?: Uint8Array;
      signal: AbortSignal;
    },
  ): Promise<BusinessFile | Json>;
}
/** 显式公开读取；无主体、无写入幂等键，业务必须只返回可公开字段。 */
export interface BusinessPublicRead {
  id: string;
  input: z.ZodType;
  output: z.ZodType;
  handle(input: unknown, context: { signal: AbortSignal }): Promise<Json>;
}
export interface BusinessPage {
  id: string;
  title: string;
  capability: string;
}
export interface BusinessJob {
  id: string;
  moduleId: string;
  input: Data;
  intervalSeconds: number;
}
export interface BusinessMigration {
  id: string;
  sql: string;
}
export interface BusinessDataResource {
  id: string;
  kind: "sql" | "object" | "external";
  /** 框架 SQL 备份不自动包含外部数据库或对象桶。 */
  backup: "host" | "business";
  retention: "business" | "framework";
  recoveryCheck: string;
  retirementCheck: string;
}
export interface BusinessInstance {
  dataResources?: readonly BusinessDataResource[];
  dependencies?: Record<string, { bindings: string[]; config: string[] }>;
  modules: Module[];
  routes?: BusinessRoute[];
  files?: BusinessFileRoute[];
  /** 产物保存后的回调（例如同步到业务自己的项目目录）；见 ArtifactStoredHook。 */
  onArtifactStored?: import("../contracts/index.js").ArtifactStoredHook;
  publicReads?: BusinessPublicRead[];
  jobs?: BusinessJob[];
  pages?: BusinessPage[];
  checks?: BusinessCheck[];
  close?: () => Promise<void>;
}
/** Token 名称和版本共同标识协议；宿主必须显式绑定实现，不能按字符串强转任意资源。 */
export interface PortToken<T> {
  id: string;
  version: number;
  check(value: unknown): value is T;
}
export interface PortBinding {
  capabilities?: readonly string[];
  token: string;
  version: number;
  identity: string;
  value: unknown;
}
export function definePort<T>(
  id: string,
  version: number,
  check: (value: unknown) => value is T,
): PortToken<T> {
  if (
    !/^[a-z][a-z0-9.-]+$/.test(id) ||
    !Number.isInteger(version) ||
    version < 1
  )
    throw new Error("PORT_TOKEN_INVALID");
  return Object.freeze({ id, version, check });
}
export class BusinessApplications {
  readonly entries: { id: string; instance: BusinessInstance }[] = [];
  add(id: string, permissions: readonly string[], instance: BusinessInstance) {
    if (this.entries.some((entry) => entry.id === id))
      throw new Error("BUSINESS_DUPLICATE");
    validateFileRoutes(instance);
    for (const contributions of contributionLists(instance)) {
      const names = new Set<string>();
      for (const entry of contributions) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || names.has(entry.id))
          throw new Error("BUSINESS_CONTRIBUTION_CONFLICT");
        if (
          entry.capability !== undefined &&
          !permissions.includes(entry.capability)
        )
          throw new Error("BUSINESS_PERMISSION_UNDECLARED");
        names.add(entry.id);
      }
    }
    if (
      (instance.checks ?? []).some(
        (c) => !["ready", "recovery", "retirement"].includes(c.phase),
      )
    )
      throw new Error("BUSINESS_CHECK_INVALID");
    for (const job of instance.jobs ?? []) {
      if (
        !instance.modules.some((m) => m.id === job.moduleId) ||
        !Number.isInteger(job.intervalSeconds) ||
        job.intervalSeconds < 60
      )
        throw new Error("BUSINESS_JOB_INVALID");
    }
    validateDataResources(instance);
    this.entries.push({ id, instance });
  }
}

/** 每类贡献各自的 id 必须唯一、合法，带权限的必须在包权限里声明。 */
function contributionLists(
  instance: BusinessInstance,
): readonly (readonly { id: string; capability?: string }[])[] {
  return [
    instance.routes ?? [],
    instance.files ?? [],
    instance.publicReads ?? [],
    instance.jobs ?? [],
    instance.pages ?? [],
    instance.checks ?? [],
    dataResources(instance),
  ];
}

function validateFileRoutes(instance: BusinessInstance) {
  for (const file of instance.files ?? [])
    if (
      file.maxBytes !== undefined &&
      (!Number.isInteger(file.maxBytes) ||
        file.maxBytes < 1 ||
        file.maxBytes > 500_000_000)
    )
      throw new Error("BUSINESS_FILE_LIMIT_INVALID");
}

function validateDataResources(instance: BusinessInstance) {
  for (const resource of instance.dataResources ?? []) {
    for (const [phase, checkId] of [
      ["recovery", resource.recoveryCheck],
      ["retirement", resource.retirementCheck],
    ]) {
      if (!instance.checks?.some((c) => c.id === checkId && c.phase === phase))
        throw new Error("BUSINESS_LIFECYCLE_CHECK_REQUIRED");
    }
    if (resource.kind === "external" && resource.backup === "host")
      throw new Error("BUSINESS_BACKUP_SCOPE_INVALID");
  }
}

function dataResources(instance: BusinessInstance) {
  return instance.dataResources ?? [];
}
