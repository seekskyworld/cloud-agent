/** 在临时源码树验证隔离门禁，避免测试夹具或供应商 SDK 静默进入生产核心。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checker = fileURLToPath(
  new URL("./check-boundaries.mjs", import.meta.url),
);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cloud-agent-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["packages", "apps", "adapters", "modules"])
    await mkdir(join(root, directory));
  return {
    async put(name, source) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), source);
    },
    check() {
      return spawnSync(process.execPath, [checker], {
        cwd: root,
        encoding: "utf8",
      });
    },
  };
}

test("production imports reject fixtures and local references outside the source graph", async (t) => {
  const tree = await fixture(t);
  await tree.put("tests/fixtures/sample.ts", "export type Sample = string;");
  await tree.put("project/reference/index.ts", "export const value = 1;");
  for (const source of [
    'import type { Sample } from "../tests/fixtures/sample.js";',
    'export { value } from "../project/reference/index.js";',
    'const value = import("../tests/fixtures/sample.js");',
    'const value = require("../project/reference/index.js");',
    'import value = require("../tests/fixtures/sample.js");',
    'type Value = import("../tests/fixtures/sample.js").Sample;',
    "const value = import(`../project/reference/index.js`);",
    'import "../project/not-installed/index.js";',
  ]) {
    await tree.put("apps/main.ts", source);
    const result = tree.check();
    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /Forbidden core dependency/, source);
  }
});

test("core rejects model SDKs and outer layers while adapters can import providers", async (t) => {
  const tree = await fixture(t);
  for (const specifier of [
    "@earendil-works/pi-ai/api/openai-responses",
    "openai",
    "@anthropic-ai/sdk",
    "@google/genai",
    "@google/generative-ai",
    "../modules/example.js",
    "../adapters/example.js",
    "../apps/example.js",
  ]) {
    await tree.put("packages/core.ts", `import "${specifier}";`);
    const result = tree.check();
    assert.equal(result.status, 1, specifier);
    assert.match(result.stderr, /Forbidden core dependency/, specifier);
  }
  await tree.put("packages/core.ts", 'import { z } from "zod";');
  await tree.put("adapters/model.ts", 'import "@earendil-works/pi-ai";');
  await tree.put("apps/main.ts", 'import "../modules/example.js";');
  await tree.put("modules/example.ts", 'import "../packages/core.js";');
  const result = tree.check();
  assert.equal(result.status, 0, result.stderr);
});

test("pure protocol and runtime dependencies keep their internal boundaries", async (t) => {
  const tree = await fixture(t);
  await tree.put("packages/api/client.ts", "export const client = 1;");
  await tree.put("packages/runtime/worker.ts", 'import "../api/client.js";');
  assert.match(tree.check().stderr, /Forbidden core dependency/);
  await tree.put("packages/runtime/worker.ts", "export const worker = 1;");
  await tree.put(
    "packages/contracts/index.ts",
    'import "../runtime/worker.js";',
  );
  assert.match(tree.check().stderr, /Forbidden core dependency/);
});

test("value cycles fail but type-only re-export cycles remain allowed", async (t) => {
  const tree = await fixture(t);
  await tree.put("packages/a.ts", 'export { value } from "./b.js";');
  await tree.put("packages/b.ts", 'export { value } from "./a.js";');
  assert.match(tree.check().stderr, /Value import cycle/);
  await tree.put("packages/a.ts", 'export type { Value } from "./b.js";');
  await tree.put("packages/b.ts", 'export { type Value } from "./a.js";');
  const result = tree.check();
  assert.equal(result.status, 0, result.stderr);
});

test("default value imports retain cycle edges alongside named type imports", async (t) => {
  const tree = await fixture(t);
  await tree.put(
    "packages/a.ts",
    'import value, { type Value } from "./b.js"; export default value;',
  );
  await tree.put(
    "packages/b.ts",
    'import value from "./a.js"; export default value; export type Value = string;',
  );
  const cycle = tree.check();
  assert.equal(cycle.status, 1);
  assert.match(cycle.stderr, /Value import cycle/);
  await tree.put(
    "packages/a.ts",
    'import { type Value } from "./b.js"; export default "safe";',
  );
  const types = tree.check();
  assert.equal(types.status, 0, types.stderr);
});

test("public connector and execution ports cannot regain persistence imports", async (t) => {
  const tree = await fixture(t);
  for (const file of [
    "packages/connectors/index.ts",
    "packages/runtime/ports.ts",
    "packages/runtime/model-ledger.ts",
    "packages/runtime/model-lifecycle.ts",
    "packages/runtime/worker.ts",
  ]) {
    await tree.put(
      file,
      'import type { Store } from "../persistence/store.js";',
    );
    assert.equal(tree.check().status, 1);
    await tree.put(file, "export {};");
  }
});
