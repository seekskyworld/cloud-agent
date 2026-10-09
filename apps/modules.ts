/** 默认只装配中立示例；使用者在这里注册自己的模块，初始化和管理目录共用能力集合。 */
import {
  integrationExamples,
  type ExampleServices,
} from "../modules/examples/index.js";
import type { Module } from "../packages/contracts/index.js";
import { moduleFactories } from "../modules/catalog.js";
export function createModules(services: ExampleServices = {}): Module[] {
  return [
    ...moduleFactories.map((factory) => factory()),
    ...(services.examples ? integrationExamples(services) : []),
  ];
}
/** 平台能力与已注册模块/工具能力去重，管理角色权限不放入业务能力目录。 */
export function registeredCapabilities(modules: readonly Module[]): string[] {
  return [
    ...new Set([
      "schedule:write",
      "task:signal",
      "task:reconcile",
      "operations:read",
      "cost:reconcile",
      "operations:cluster",
      "memory:read",
      "memory:write",
      "mail:use",
      "channel:use",
      ...modules.flatMap((module) => [
        module.capability,
        ...module.tools.map((tool) => tool.capability),
      ]),
    ]),
  ].sort();
}
