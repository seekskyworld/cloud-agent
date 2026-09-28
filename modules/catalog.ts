/** 可信部署清单：只注册静态导入的模块，历史版本保留到任务排空。 */
import type { Module } from "../packages/contracts/index.js";
import { reportModule } from "./report-assistant/index.js";
import { textModule } from "./text-assistant/index.js";
export const moduleFactories: (() => Module)[] = [
  reportModule,
  () => reportModule(true),
  textModule,
  // generated:factories
];
/** 多版本共存时显式指定新任务的默认版本。 */
export const defaultModuleVersions: Record<string, string> = {};
