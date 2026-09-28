/** 离线评测仅接收纯回放器；测试案例和基线版本化，禁止通过评测入口发出真实写操作。 */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { bounded } from "../contracts/lifecycle.js";
export const EvaluationCase = z
  .object({
    id: z.string(),
    version: z.string(),
    input: z.json(),
    expected: z.json(),
    expectedTools: z.array(z.string()).optional(),
    maxCostUsd: z.number().nonnegative(),
    maxLatencyMs: z.number().positive(),
  })
  .strict();
export type EvaluationCase = z.infer<typeof EvaluationCase>;
export interface ReplayAdapter {
  mode: "offline";
  run(
    input: unknown,
  ): Promise<{ output: unknown; costUsd: number; tools: string[] }>;
}
export async function evaluate(cases: EvaluationCase[], replay: ReplayAdapter) {
  if (replay.mode !== "offline") throw new Error("EVALUATION_OFFLINE_REQUIRED");
  const results = [];
  for (const raw of cases) {
    const item = EvaluationCase.parse(raw),
      started = performance.now();
    try {
      const actual = await bounded(item.maxLatencyMs, () =>
        replay.run(item.input),
      );
      const latencyMs = performance.now() - started;
      results.push({
        id: item.id,
        version: item.version,
        passed:
          isDeepStrictEqual(actual.output, item.expected) &&
          (!item.expectedTools ||
            isDeepStrictEqual(actual.tools, item.expectedTools)) &&
          Number.isFinite(actual.costUsd) &&
          actual.costUsd >= 0 &&
          actual.costUsd <= item.maxCostUsd &&
          latencyMs <= item.maxLatencyMs,
        costUsd: actual.costUsd,
        latencyMs,
        tools: actual.tools,
      });
    } catch {
      results.push({
        id: item.id,
        version: item.version,
        passed: false,
        code: "EVALUATION_FAILED",
        latencyMs: performance.now() - started,
      });
    }
  }
  return { passed: results.every((r) => r.passed), results };
}
