/** 测试夹具：首次写入后收集子任务失败，经审批执行补偿；不定义领域资源。 */
import { z } from "zod";
import type { Module, ExecutionContext, Data } from "cloud-agent/sdk";
export interface CompensationPort {
  /** 宿主适配器必须按 context.idempotencyKey 去重，并返回可核实的回执。 */
  apply(
    reference: string,
    context: ExecutionContext,
  ): Promise<{ receipt: string }>;
  compensate(
    receipt: string,
    context: ExecutionContext,
  ): Promise<{ receipt: string }>;
}
export function compensationFixture(port: CompensationPort): Module {
  return {
    id: "fixture-compensation",
    version: "1.0.0",
    title: "显式补偿批处理",
    description: "写入、并行处理、确认补偿",
    capability: "fixture:use",
    input: z
      .object({
        reference: z.string().min(1),
        children: z
          .array(
            z.object({
              moduleId: z.string(),
              input: z.record(z.string(), z.json()),
            }),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    example: {
      reference: "example",
      children: [
        { moduleId: "report", input: { title: "report", values: [1] } },
      ],
    },
    runtime: { model: false },
    tools: [
      {
        name: "fixture.apply",
        version: "1",
        description: "模拟首次写入",
        capability: "fixture:use",
        effect: "idempotent_write",
        timeoutMs: 5000,
        input: z.object({ reference: z.string() }),
        output: z.object({ receipt: z.string() }),
        execute: async (input, context) => ({
          kind: "succeeded",
          output: await port.apply(String(input.reference), context),
        }),
      },
      {
        name: "fixture.compensate",
        version: "1",
        description: "模拟补偿写入",
        capability: "fixture:use",
        effect: "idempotent_write",
        approval: true,
        timeoutMs: 5000,
        input: z.object({ receipt: z.string() }),
        output: z.object({ receipt: z.string() }),
        execute: async (input, context) => ({
          kind: "succeeded",
          output: await port.compensate(String(input.receipt), context),
        }),
      },
    ],
    next(input, steps) {
      const applied = steps.find((s) => s.key === "apply");
      if (!applied)
        return {
          kind: "tool",
          key: "apply",
          name: "fixture.apply",
          input: { reference: input.reference! },
        };
      const batch = steps.find((s) => s.key === "batch");
      if (!batch)
        return {
          kind: "children",
          key: "batch",
          onFailure: "collect",
          children: input.children as { moduleId: string; input: Data }[],
        };
      const failed = z
        .array(z.object({ status: z.string() }))
        .parse(batch.output)
        .some((child) => child.status !== "succeeded");
      if (failed && !steps.some((s) => s.key === "compensate"))
        return {
          kind: "tool",
          key: "compensate",
          name: "fixture.compensate",
          input: z.object({ receipt: z.string() }).parse(applied.output),
        };
      return {
        kind: "complete",
        result: { compensated: failed, children: batch.output! },
      };
    },
  };
}
