/** 版本化离线回放仅运行内置纯编排；数据文件不携带可执行代码或网络目标。 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { DataSchema } from "../packages/contracts/index.js";
import { evaluate, EvaluationCase } from "../packages/runtime/evaluation.js";
import { createModules } from "../apps/modules.js";
const data = z
  .object({ version: z.literal(1), cases: z.array(EvaluationCase) })
  .parse(JSON.parse(await readFile("tests/evaluations/baseline.json", "utf8")));
const report = await evaluate(data.cases, {
  mode: "offline",
  async run(input) {
    const request = z
      .object({ moduleId: z.string(), input: z.record(z.string(), z.json()) })
      .parse(input);
    const module = createModules().find((m) => m.id === request.moduleId);
    if (!module) throw new Error("EVALUATION_MODULE_NOT_FOUND");
    const parsed = module.input.parse(request.input);
    const action = module.next(DataSchema.parse(parsed), []);
    return {
      output: action,
      costUsd: 0,
      tools: action.kind === "tool" ? [action.name] : [],
    };
  },
});
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/evaluation.json",
  JSON.stringify(report, null, 2),
);
process.stdout.write(
  JSON.stringify({ passed: report.passed, cases: report.results.length }) +
    "\n",
);
if (!report.passed) process.exitCode = 1;
