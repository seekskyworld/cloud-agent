/** 最小模型模块：引擎只执行单轮请求，任务状态、预算和结果由运行时保存。 */
import { z } from "zod";
import {
  Problem,
  type Module,
  type ModelTurn,
} from "../../packages/contracts/index.js";
export function textModule(version = "1.1.0"): Module {
  return {
    id: "text",
    version,
    title: "文本处理示例",
    description:
      "演示单轮模型调用；默认模式只回显输入，配置模型后按要求处理文本",
    runtime: { model: true, acceptLegacyProfile: true },
    capability: "text:run",
    input: z
      .object({
        text: z.string().trim().min(1).max(12000),
        instruction: z.string().trim().min(1).max(1000),
      })
      .strict(),
    example: {
      text: "任务状态保存在数据库中，服务重启后可以恢复执行。",
      instruction: "将文本改写为简短易懂的一句话。",
    },
    tools: [],
    next(input, steps) {
      const generated = steps.find((step) => step.key === "generate");
      if (!generated)
        return {
          kind: "model",
          key: "generate",
          request: {
            instructions: String(input.instruction),
            messages: [{ role: "user", text: String(input.text) }],
            tools: [],
          },
        };
      const output = generated.output as unknown as ModelTurn;
      if (output.calls.length) throw new Problem(422, "UNEXPECTED_TOOL_CALL");
      return {
        kind: "complete",
        title: "文本处理结果",
        result: { text: output.text },
      };
    },
  };
}
