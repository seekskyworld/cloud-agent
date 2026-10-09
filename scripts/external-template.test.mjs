import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
test("independent template does not overwrite existing projects or import host source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-agent-template-"));
  try {
    const artifact = join(dir, "sdk.tgz"),
      target = join(dir, "project");
    await writeFile(artifact, "fixture");
    await run(process.execPath, [
      resolve("scripts/create-external.mjs"),
      "mail",
      "example-mail",
      target,
      artifact,
    ]);
    const source = await readFile(join(target, "index.ts"), "utf8");
    assert.ok(source.includes("@cloud-agent/sdk/connectors"));
    assert.ok(!source.includes("../apps"));
    await assert.rejects(
      run(process.execPath, [
        resolve("scripts/create-external.mjs"),
        "business",
        "replacement",
        target,
        artifact,
      ]),
    );
    assert.equal(await readFile(join(target, "index.ts"), "utf8"), source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
