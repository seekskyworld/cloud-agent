/** 完整业务应用的贡献协议；宿主注入可信身份、截止信号与请求键。 */
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
export interface BusinessInstance {
  dependencies?: Record<string, { bindings: string[]; config: string[] }>;
  modules: Module[];
  routes?: BusinessRoute[];
  jobs?: BusinessJob[];
  pages?: BusinessPage[];
  close?: () => Promise<void>;
}
/** Token 名称和版本共同标识协议；宿主必须显式绑定实现，不能按字符串强转任意资源。 */
export interface PortToken<T> {
  id: string;
  version: number;
  check(value: unknown): value is T;
}
export interface PortBinding {
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
    for (const contributions of [
      instance.routes ?? [],
      instance.jobs ?? [],
      instance.pages ?? [],
    ]) {
      const names = new Set<string>();
      for (const entry of contributions) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || names.has(entry.id))
          throw new Error("BUSINESS_CONTRIBUTION_CONFLICT");
        if ("capability" in entry && !permissions.includes(entry.capability))
          throw new Error("BUSINESS_PERMISSION_UNDECLARED");
        names.add(entry.id);
      }
    }
    for (const job of instance.jobs ?? []) {
      if (
        !instance.modules.some((m) => m.id === job.moduleId) ||
        !Number.isInteger(job.intervalSeconds) ||
        job.intervalSeconds < 60
      )
        throw new Error("BUSINESS_JOB_INVALID");
    }
    this.entries.push({ id, instance });
  }
}
