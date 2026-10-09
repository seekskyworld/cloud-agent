/** 无外部服务的最小模块示例：纯编排、补充输入、统计工具与可选人工确认。 */
import { z } from "zod";
import type { Module } from "../../packages/contracts/index.js";
export function reportModule(requireApproval = false): Module {
  const id = requireApproval ? "reviewed-report" : "report";
  const input = z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      values: z
        .array(z.number().finite().min(-1e12).max(1e12))
        .min(1)
        .max(1000),
    })
    .strict();
  return {
    id,
    version: "1.1.0",
    title: requireApproval ? "确认报告示例" : "数据报告示例",
    description: requireApproval
      ? "确认参数后计算统计指标；不会调用外部系统"
      : "计算统计指标，演示补充输入和结果下载",
    runtime: { model: false, acceptLegacyProfile: true },
    capability: "report:run",
    input,
    example: { values: [12, 18, 24, 30] },
    tools: [
      {
        name: `${id}.calculate`,
        version: "1",
        description: "计算数值列表的统计信息",
        input,
        output: z.object({
          title: z.string(),
          count: z.number(),
          sum: z.number(),
          average: z.number(),
          min: z.number(),
          max: z.number(),
        }),
        capability: "report:run",
        effect: "read",
        approval: requireApproval,
        timeoutMs: 1000,
        async execute(data) {
          const values = data.values as number[];
          const sum = values.reduce((a, b) => a + b, 0);
          return {
            kind: "succeeded",
            output: {
              title: String(data.title),
              count: values.length,
              sum,
              average: sum / values.length,
              min: Math.min(...values),
              max: Math.max(...values),
            },
          };
        },
      },
    ],
    next(data, steps) {
      const title =
        data.title ??
        (
          steps.find((s) => s.key === "title")?.output as
            | { title?: string }
            | undefined
        )?.title;
      if (!title)
        return {
          kind: "wait",
          key: "title",
          waitKind: "input",
          reason: "请补充报告标题",
          schema: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 120 },
            },
            required: ["title"],
            additionalProperties: false,
          },
          expiresInMs: 86_400_000,
        };
      const calculated = steps.find((s) => s.key === "calculate");
      if (!calculated)
        return {
          kind: "tool",
          key: "calculate",
          name: `${id}.calculate`,
          input: { ...data, title },
        };
      return {
        kind: "complete",
        result: calculated.output!,
        title: String(title),
      };
    },
  };
}
