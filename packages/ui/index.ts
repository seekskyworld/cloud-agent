import type { ComponentType } from "react";
import type { CloudAgentClient } from "../api/client.js";
import type { Detail } from "../api/contracts.js";
export type Schema = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
};
export type InputProps = {
  schema: Schema;
  value: string;
  onChange: (value: string) => void;
  label: string;
};
export type ResultProps = { result: unknown };
export interface ModuleView {
  moduleId: string;
  Input?: ComponentType<InputProps>;
  Result?: ComponentType<ResultProps>;
  Actions?: ComponentType<{
    detail: Detail;
    client: CloudAgentClient;
    refresh: () => Promise<void>;
  }>;
}
export function defineViews(
  entries: readonly ModuleView[],
): Record<string, ModuleView> {
  const result: Record<string, ModuleView> = Object.create(null);
  for (const entry of entries) {
    if (result[entry.moduleId]) throw new Error("MODULE_VIEW_DUPLICATE");
    result[entry.moduleId] = entry;
  }
  return result;
}

/** 页面组件在可信构建阶段注册；导航由服务端已启用业务和当前权限共同决定。 */
export interface BusinessView {
  packageId: string;
  pageId: string;
  sdkMajor: 1;
  Component: ComponentType<{ client: CloudAgentClient }>;
}
export function defineBusinessViews(entries: readonly BusinessView[]) {
  const views: Record<string, BusinessView> = Object.create(null);
  for (const entry of entries) {
    const id = `${entry.packageId}/${entry.pageId}`;
    if (entry.sdkMajor !== 1 || views[id])
      throw new Error("BUSINESS_VIEW_INCOMPATIBLE");
    views[id] = entry;
  }
  return views;
}
