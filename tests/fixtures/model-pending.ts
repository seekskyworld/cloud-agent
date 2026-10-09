/** 浏览器专用失联模型：只挂起合成请求，其余请求沿用无网络演示引擎。 */
import { z } from "zod";
import type { ModelEngine, Module } from "../../packages/contracts/index.js";
import { DemoEngine } from "../../adapters/engine-pi/index.js";
export const pendingModel: ModelEngine = {
  id: "demo:echo-v1",
  next: (request) =>
    request.instructions === "fixture:unknown"
      ? new Promise(() => {})
      : new DemoEngine().next(request),
};
export const pendingModule: Module = {
  id: "browser-model-unknown",
  version: "1",
  title: "模型状态核对示例",
  description: "browser fixture",
  capability: "report:run",
  runtime: { model: true },
  input: z.object({}),
  example: {},
  tools: [],
  budget: { maxDurationMs: 100 },
  next: () => ({
    kind: "model",
    key: "model",
    request: { instructions: "fixture:unknown", messages: [], tools: [] },
  }),
};
