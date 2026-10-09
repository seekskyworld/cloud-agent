// 只生成可信源码；独占目录与清单锁防止覆盖已有模块或并发丢失注册。
import { mkdir, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import { resolve } from "node:path";
const id = process.argv[2];
if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 64)
  throw new Error("Usage: pnpm module:create <kebab-case-id>");
const catalog = resolve("modules/catalog.ts"),
  directory = resolve("modules", id);
const lock = await open(`${catalog}.lock`, "wx");
let created = false;
try {
  const previous = await readFile(catalog, "utf8");
  if (!previous.includes("// generated:factories"))
    throw new Error("Missing module catalog marker");
  const name = `${id.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())}Module`;
  if (
    new RegExp(`\\b${name}\\b`).test(previous) ||
    previous.includes(`"./${id}/index.js"`)
  )
    throw new Error("Module already registered");
  await mkdir(directory);
  created = true;
  await writeFile(
    `${directory}/index.ts`,
    `/** 纯函数模块：在这里定义业务编排，外部调用放入工具与适配器。 */
import { z } from "zod";
import type { Module } from "../../packages/contracts/index.js";
export function ${name}(): Module {
  return {
    id: ${JSON.stringify(id)}, version: "1.0.0", title: ${JSON.stringify(id)},
    description: "自定义模块", capability: ${JSON.stringify(id + ":run")},
    runtime: { model: false, config: {} },
    input: z.object({ text: z.string().min(1).max(12000) }).strict(),
    example: { text: "Hello Cloud Agent" }, tools: [],
    next(input) { return { kind: "complete", result: { text: input.text! } }; },
  };
}
`,
    { flag: "wx" },
  );
  const updated =
    `import { ${name} } from "./${id}/index.js";\n` +
    previous.replace(
      "// generated:factories",
      `${name},\n  // generated:factories`,
    );
  await writeFile(`${catalog}.next`, updated, { flag: "wx" });
  await rename(`${catalog}.next`, catalog);
  created = false;
  process.stdout.write(
    `Created modules/${id}/index.ts and registered catalog. Grant ${id}:run to existing members, then rebuild API and Worker.\n`,
  );
} finally {
  if (created) await rm(directory, { recursive: true, force: true });
  await lock.close();
  await rm(`${catalog}.lock`);
}
