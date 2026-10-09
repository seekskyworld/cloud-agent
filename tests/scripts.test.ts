/** 运维脚本不得覆盖或清理调用方已经存在的配置与备份文件。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
test("备份路径已存在时拒绝操作且保留旧备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-agent-backup-"));
  const path = join(dir, "existing.sql");
  try {
    await writeFile(path, "existing backup");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/backup.mjs"), path],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path, "utf8"), "existing backup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("初始化凭据为私有文件，重跑不覆盖旧凭据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-agent-env-"));
  try {
    const run = () =>
      spawnSync(process.execPath, [resolve("scripts/init-env.mjs")], {
        cwd: dir,
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    const path = join(dir, ".env");
    const original = await readFile(path, "utf8");
    assert.match(original, /AUTH_MODE=none/);
    assert.ok(!original.includes("BOOTSTRAP_TOKEN"));
    assert.match(original, /POSTGRES_PASSWORD=[a-f0-9]{48}/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("邮件和渠道模板均可编译，重复生成保留现有源码", async (t) => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "cloud-extension-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "adapters"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  for (const name of ["packages", "node_modules"])
    await symlink(resolve(name), join(dir, name));
  await symlink(resolve("adapters/mail"), join(dir, "adapters/mail"));
  const sources = [];
  for (const kind of ["mail", "channel"]) {
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve("scripts/create-extension.mjs"), kind, `fixture-${kind}`],
        { cwd: dir, encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const source = join(dir, `adapters/fixture-${kind}/index.ts`),
      original = await readFile(source, "utf8");
    sources.push(source);
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(source, "utf8"), original);
  }
  const compiled = spawnSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--strict",
      "--module",
      "nodenext",
      "--target",
      "es2023",
      "--skipLibCheck",
      "--noEmit",
      ...sources,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test("独立业务包与邮件 SDK 类型不依赖宿主的全局 Node 类型", async (t) => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "cloud-agent-source-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "modules"));
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await writeFile(
    join(dir, "modules/packages.ts"),
    "export const businessPackages = [\n// generated:packages\n];\n",
  );
  await symlink(resolve("."), join(dir, "node_modules/cloud-agent"));
  await symlink(resolve("node_modules/zod"), join(dir, "node_modules/zod"));
  const generated = spawnSync(
    process.execPath,
    [resolve("scripts/create-package.mjs"), "sample"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  await writeFile(
    join(dir, "verify.ts"),
    `import { samplePackage } from './modules/sample-package/index.js';
import type { MailProvider } from 'cloud-agent/sdk';
export const sample = samplePackage;
export const verify: NonNullable<MailProvider['verifyWebhook']> = (raw: Uint8Array) => ({id:'event',messageId:'message',digest:String(raw.byteLength)});
verify(new Uint8Array([1, 2]), {});
`,
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: false,
        target: "ES2023",
        module: "NodeNext",
        types: [],
      },
      files: ["verify.ts"],
    }),
  );
  const compiled = spawnSync(
    process.execPath,
    [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
