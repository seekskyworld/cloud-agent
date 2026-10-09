/** 隔离进程故障注入，无外部网络或真实副作用。 */
import { z } from "zod";
import type { Module, Data } from "../../packages/contracts/index.js";
export function createModule(config: Data): Module {
  return {
    id: "isolated",
    version: "1",
    title: "isolated",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    runtime: { model: false },
    next() {
      if (config.behavior === "block") {
        while (true) {
          /* 故意阻塞子进程以验证强制退出。 */
        }
      }
      if (config.behavior === "exit") process.exit(2);
      return {
        kind: "complete",
        result: { safe: !process.env.CONNECTION_CREDENTIALS },
      };
    },
    tools: [
      {
        name: "write",
        version: "1",
        description: "fixture",
        input: z.object({}),
        output: z.object({}),
        capability: "report:run",
        effect: "unsafe_write",
        timeoutMs: 2000,
        execute: async () => {
          process.exit(2);
        },
      },
    ],
  };
}
