/** 可选业务包示例：仅声明逻辑文件依赖，具体本地/S3 存储由部署绑定。 */
import { z } from "zod";
import { defineBusinessPackage, type Tool } from "../../packages/sdk/index.js";
export const starterPackage = defineBusinessPackage({
  id: "starter",
  version: "1.0.0",
  sdkMajor: 1,
  permissions: ["starter:run"],
  config: z.object({ prefix: z.string().max(40).default("报告") }).strict(),
  requires: { output: { kind: "artifacts" } },
  create(config, services) {
    const input = z.object({ text: z.string().min(1).max(40000) }).strict();
    const tool: Tool = {
      name: "starter.write",
      version: "1.0.0",
      description: "生成文本附件",
      input,
      output: z.record(z.string(), z.json()),
      capability: "starter:run",
      effect: "idempotent_write",
      timeoutMs: 20000,
      async execute(value, context) {
        return {
          kind: "succeeded",
          output: await services
            .files("output")
            .put(
              context,
              "report.txt",
              "text/plain",
              Buffer.from(`${config.prefix}\n${value.text}`),
            ),
        };
      },
    };
    return {
      modules: [
        {
          id: "starter-report",
          version: "1.0.0",
          title: "业务包报告",
          description: "独立业务包生成附件",
          input,
          example: { text: "Hello Cloud Agent" },
          capability: "starter:run",
          tools: [tool],
          runtime: { model: false },
          next(value, steps) {
            return steps.length
              ? { kind: "complete", result: steps[0]!.output }
              : { kind: "tool", key: "file", name: tool.name, input: value };
          },
        },
      ],
    };
  },
});
