/** 应用边界与滚动升级回归，使用隔离数据库和纯本地供应商。 */
import test from "node:test";
import assert from "node:assert/strict";
import { setup, principal, drain } from "./helpers.js";
import { createContainer } from "../apps/container.js";
import { reportModule } from "../modules/report-assistant/index.js";

test("任务服务刷新旧身份，拒绝越权重试与读取但允许所有者停止任务", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const task = await c.service.create(
    principal,
    "report",
    { values: [1] },
    "service",
  );
  assert.equal(
    (await c.service.create(principal, "report", { values: [1] }, "service"))
      .id,
    task.id,
  );
  await drain(c);
  const wait = (await c.service.detail(principal, task.id)).waits[0]!;
  await c.db.pool.query(
    "UPDATE principals SET capabilities='{}' WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(
    c.service.respond(principal, wait.id, { title: "x" }, "reply"),
    /FORBIDDEN/,
  );
  await assert.rejects(
    c.service.create(principal, "report", { values: [1] }, "revoked"),
    /FORBIDDEN/,
  );
  await assert.rejects(c.service.events(principal, task.id, "0"), /FORBIDDEN/);
  assert.equal((await c.service.notification(principal, task.id))!.task, null);
  await c.service.cancel(principal, task.id);
  assert.equal((await c.tasks.get(principal, task.id)).status, "cancelled");
});

test("模型配置变化不影响纯计算，模型任务仅由兼容 Worker 领取，旧指纹可恢复", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const report = await c.service.create(
    principal,
    "report",
    { title: "x", values: [1] },
    "report",
  );
  const model = await c.service.create(
    principal,
    "text",
    { text: "x", instruction: "y" },
    "model",
  );
  const changed = await createContainer({ ...c.config, LLM_MODEL: "other" });
  t.after(() => changed.db.close());
  await drain(changed);
  assert.equal((await c.tasks.get(principal, report.id)).status, "succeeded");
  assert.equal((await c.tasks.get(principal, model.id)).status, "queued");
  await c.db.pool.query("UPDATE tasks SET config_hash=$2 WHERE id=$1", [
    model.id,
    c.registry.hash(c.registry.get("text"), true),
  ]);
  assert.equal(await changed.worker.tick(), false);
  await drain(c);
  assert.equal((await c.tasks.get(principal, model.id)).status, "succeeded");
});

test("新默认版本不隐藏历史版本，历史任务继续由其原版本执行", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const old = await c.service.create(
    principal,
    "report",
    { title: "old", values: [1] },
    "old",
  );
  const next = { ...reportModule(), version: "2.0.0" };
  c.registry.register(next);
  assert.equal(c.registry.get("report").version, "1.1.0");
  const { z } = await import("zod");
  next.input = z.object({
    title: z.string(),
    values: z.array(z.number()),
    newRequired: z.string(),
  });
  next.next = (input) => ({
    kind: "complete",
    result: { version: 2, title: input.title! },
  });
  next.tools = [];
  c.registry.setDefault("report", "2.0.0");
  assert.equal(
    (
      await c.service.create(
        principal,
        "report",
        { title: "old", values: [1] },
        "old",
      )
    ).id,
    old.id,
  );
  assert.equal(c.registry.active().filter((m) => m.id === "report").length, 1);
  const task = await c.service.create(
    principal,
    "report",
    { title: "new", values: [2], newRequired: "v2" },
    "new",
  );
  assert.equal(task.module_version, "2.0.0");
  await drain(c);
  assert.equal((await c.tasks.get(principal, old.id)).status, "succeeded");
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});

test("辅助循环失败可恢复且独立记录健康，不传播供应商异常", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const { runLoop } = await import("../packages/runtime/loop.js");
  let calls = 0;
  await runLoop({
    id: "fixture",
    kind: "mail_receive",
    operations: c.operations,
    stopping: () => calls >= 1,
    intervalMs: 1,
    tick: async () => {
      calls++;
      throw new Error("secret supplier response");
    },
  });
  const health = await c.db.pool.query(
    "SELECT * FROM loop_health WHERE id='fixture'",
  );
  assert.equal(health.rows[0].error, "CYCLE_FAILED");
  calls = 0;
  await runLoop({
    id: "fixture",
    kind: "mail_receive",
    operations: c.operations,
    stopping: () => calls >= 1,
    intervalMs: 1,
    tick: async () => {
      calls++;
    },
  });
  assert.equal(
    (await c.db.pool.query("SELECT error FROM loop_health WHERE id='fixture'"))
      .rows[0].error,
    null,
  );
});

test("模块命令生成可编译可执行模块，清单注册且重复执行不覆盖源码", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "cloud-module-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "modules"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await writeFile(
    join(dir, "modules/catalog.ts"),
    "export const moduleFactories = [\n// generated:factories\n];",
  );
  await symlink(resolve("packages"), join(dir, "packages"));
  await symlink(resolve("node_modules"), join(dir, "node_modules"));
  const run = () =>
    spawnSync(
      process.execPath,
      [resolve("scripts/create-module.mjs"), "generated-echo"],
      { cwd: dir, encoding: "utf8" },
    );
  assert.equal(run().status, 0);
  const source = join(dir, "modules/generated-echo/index.ts"),
    original = await readFile(source, "utf8");
  assert.notEqual(run().status, 0);
  assert.equal(await readFile(source, "utf8"), original);
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
      join(dir, "modules/catalog.ts"),
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { moduleFactories } = await import(
    pathToFileURL(join(dir, "modules/catalog.ts")).href
  );
  const c = await setup();
  t.after(() => c.db.close());
  c.registry.register(moduleFactories[0]());
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_append(capabilities,'generated-echo:run')",
  );
  const task = await c.service.create(
    principal,
    "generated-echo",
    { text: "generated" },
    "generated",
  );
  await drain(c);
  assert.deepEqual((await c.service.get(principal, task.id)).result, {
    text: "generated",
  });
});

test("轨迹归档先预览、可重入，事件游标/结果/幂等保留且排除未知写入", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const { ArchiveStore } = await import("../packages/persistence/archive.js");
  const store = new ArchiveStore(c.db),
    policy = { retentionDays: 30, batchSize: 20, apply: false };
  const input = { title: "归档", values: [1, 2] },
    task = await c.service.create(principal, "report", input, "archive");
  await drain(c);
  const before = await c.service.events(principal, task.id, "0");
  const result = (await c.service.detail(principal, task.id)).task.result;
  await c.db.pool.query(
    "UPDATE tasks SET updated_at=now()-interval '31 days' WHERE id=$1",
    [task.id],
  );
  assert.equal((await store.run(policy)).archived, 0);
  assert.deepEqual((await store.run(policy)).candidates, [task.id]);
  await c.db.pool.query(
    "UPDATE tool_invocations SET status='unknown' WHERE task_id=$1",
    [task.id],
  );
  assert.equal((await store.run({ ...policy, apply: true })).archived, 0);
  await c.db.pool.query(
    "UPDATE tool_invocations SET status='succeeded' WHERE task_id=$1",
    [task.id],
  );
  assert.equal((await store.run({ ...policy, apply: true })).archived, 1);
  assert.equal((await store.run({ ...policy, apply: true })).archived, 0);
  assert.equal(
    (await c.db.pool.query("SELECT 1 FROM events WHERE task_id=$1", [task.id]))
      .rowCount,
    0,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await c.service.events(principal, task.id, "0"))),
    JSON.parse(JSON.stringify(before)),
  );
  assert.deepEqual(
    (await c.service.events(principal, task.id, before[1]!.id)).map(
      (e) => e.id,
    ),
    before.slice(2).map((e) => e.id),
  );
  assert.deepEqual(
    (await c.service.detail(principal, task.id)).task.result,
    result,
  );
  assert.equal(
    (await c.service.create(principal, "report", input, "archive")).id,
    task.id,
  );
  await assert.rejects(
    c.service.create(
      principal,
      "report",
      { title: "changed", values: [1] },
      "archive",
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
  await c.db.pool.query(
    "INSERT INTO events(task_id,type) VALUES($1,'late.audit')",
    [task.id],
  );
  assert.equal((await store.run({ ...policy, apply: true })).archived, 1);
  assert.equal(
    (await c.service.events(principal, task.id, "0")).length,
    before.length + 1,
  );
  await c.db.pool.query(
    "UPDATE task_archives SET checksum='invalid' WHERE task_id=$1",
    [task.id],
  );
  await assert.rejects(
    c.service.events(principal, task.id, "0"),
    /ARCHIVE_CORRUPTED/,
  );
});

test("就绪探测独立于报表，分类健康与兼容积压指标可观测", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  assert.equal((await c.operations.ready()).worker, false);
  await c.operations.heartbeat("task");
  assert.equal((await c.operations.ready()).maintenance, false);
  await c.operations.loopHeartbeat("task", "maintenance");
  await c.operations.loopHeartbeat("mail", "mail_receive", "CYCLE_FAILED");
  c.operations.snapshot = async () => {
    throw new Error("expensive report unavailable");
  };
  assert.deepEqual(await c.operations.ready(), {
    database: true,
    worker: true,
    maintenance: true,
    compatible: true,
  });
  const { Operations } = await import("../packages/observability/service.js");
  await c.service.create(principal, "report", { values: [1] }, "blocked");
  c.registry.get("report").budget = { maxSteps: 1 };
  const metrics = await new Operations(c.db, c.registry).metrics(
    principal.workspace_id,
    true,
  );
  assert.match(metrics, /cloud_agent_tasks_incompatible 1/);
  assert.match(
    metrics,
    /cloud_agent_loops\{kind="mail_receive",state="failed"\} 1/,
  );
  await c.db.pool.query(
    "UPDATE worker_heartbeats SET seen_at=now()-interval '8 days'",
  );
  await c.operations.pruneHeartbeats();
  assert.equal((await c.operations.ready()).worker, false);
});

test("归档与热事件混合分页按数值游标排序，超过百条也不遗漏", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const task = await c.service.create(
    principal,
    "report",
    { title: "pages", values: [1] },
    "pages",
  );
  await drain(c);
  await c.db.pool.query(
    "INSERT INTO events(task_id,type) SELECT $1,'fixture' FROM generate_series(1,150)",
    [task.id],
  );
  const first = await c.service.events(principal, task.id, "0");
  assert.equal(first.length, 100);
  assert.ok(
    first.every(
      (row, i) => i === 0 || BigInt(row.id) > BigInt(first[i - 1]!.id),
    ),
  );
  await c.db.pool.query(
    "UPDATE tasks SET updated_at=now()-interval '31 days' WHERE id=$1",
    [task.id],
  );
  const { ArchiveStore } = await import("../packages/persistence/archive.js");
  await new ArchiveStore(c.db).run({
    retentionDays: 30,
    batchSize: 20,
    apply: true,
  });
  await c.db.pool.query(
    "INSERT INTO events(task_id,type) SELECT $1,'fixture-hot' FROM generate_series(1,150)",
    [task.id],
  );
  const ids: string[] = [];
  let cursor = "0";
  while (true) {
    const page = await c.service.events(principal, task.id, cursor);
    if (!page.length) break;
    ids.push(...page.map((e) => e.id));
    cursor = page.at(-1)!.id;
  }
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.length > 300);
  assert.ok(ids.every((id, i) => i === 0 || BigInt(id) > BigInt(ids[i - 1]!)));
});

test("旧邮件线程与任务关联升级后保留，同一来信线程仍映射原会话", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const task = await c.service.create(
    principal,
    "report",
    { values: [1] },
    "legacy",
  );
  // 仅在运行器新建的隔离库复原 004 的表形状，验证追加迁移承接真实旧记录。
  await c.db.pool.query(
    "DROP TABLE task_archives,loop_health,conversation_bindings; DROP INDEX tasks_retention,attempts_step; ALTER TABLE mail_tasks DROP COLUMN principal_id,DROP COLUMN checked_at; DELETE FROM schema_migrations WHERE name IN ('005_application.sql','006_operations.sql','007_archives.sql')",
  );
  await c.db.pool.query(
    "INSERT INTO mailboxes(id,workspace_id,remote_id) VALUES('legacy-inbox',$1,'legacy-inbox')",
    [principal.workspace_id],
  );
  await c.db.pool.query(
    "INSERT INTO mail_threads VALUES('legacy-inbox',$1,'legacy-thread',$2)",
    [principal.id, task.conversation_id],
  );
  await c.db.pool.query(
    "INSERT INTO mail_tasks VALUES($1,'legacy-inbox','user@example.test','message','subject')",
    [task.id],
  );
  await c.db.migrate();
  assert.equal(
    await c.service.conversationFor(
      principal,
      "mail:legacy-inbox",
      "legacy-thread",
      "unchanged",
    ),
    task.conversation_id,
  );
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT principal_id FROM mail_tasks WHERE task_id=$1",
        [task.id],
      )
    ).rows[0].principal_id,
    principal.id,
  );
  assert.equal((await c.service.get(principal, task.id)).status, "queued");
});

test("统一服务保留信号幂等和重试约束，撤权后旧调用方不能恢复执行", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const task = await c.service.create(
    principal,
    "report",
    { values: [1] },
    "service-signal",
  );
  await c.service.signal(principal, task.id, "external", { value: 1 }, "event");
  await c.service.signal(principal, task.id, "external", { value: 1 }, "event");
  await assert.rejects(
    c.service.signal(principal, task.id, "external", { value: 2 }, "event"),
    /EVENT_CONFLICT/,
  );
  await drain(c);
  await c.db.pool.query(
    "UPDATE waits SET expires_at=now()-interval '1 second' WHERE task_id=$1",
    [task.id],
  );
  await c.waits.expire();
  await c.service.retry(principal, task.id);
  assert.equal((await c.service.get(principal, task.id)).status, "queued");
  await c.db.pool.query(
    "UPDATE principals SET capabilities='{}' WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(c.service.retry(principal, task.id), /FORBIDDEN/);
  await assert.rejects(
    c.service.signal(principal, task.id, "revoked", {}, "revoked"),
    /FORBIDDEN/,
  );
});
