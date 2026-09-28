/** 直接执行公开教程源码，避免文档示例与真实 Worker 行为漂移。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BusinessPackage } from "../packages/business/index.js";
import { Worker } from "../packages/runtime/worker.js";
import { DemoEngine } from "../adapters/engine-pi/index.js";
import { setup, principal, drain } from "./helpers.js";

test("公开工具教程完成授权、确认、Worker 重启、同键重放和拒绝闭环", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-agent-tutorial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile("docs/getting-started.md", "utf8");
  const code = /<!-- tutorial:tool-package -->\s*```ts\n([\s\S]*?)\n```/.exec(
    source,
  )?.[1];
  assert.ok(code);
  await mkdir(join(directory, "node_modules"));
  await symlink(resolve("."), join(directory, "node_modules/cloud-agent"));
  await symlink(
    resolve("node_modules/zod"),
    join(directory, "node_modules/zod"),
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(join(directory, "index.ts"), code);
  const { greetingPackage } = (await import(
    pathToFileURL(join(directory, "index.ts")).href
  )) as { greetingPackage: BusinessPackage };
  const instance = await greetingPackage.create({}, {} as never);
  const module = instance.modules[0]!;
  let executions = 0;
  const execute = module.tools[0]!.execute;
  module.tools[0]!.execute = async (...args) => {
    executions++;
    return execute(...args);
  };
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(module);
  await assert.rejects(
    c.service.create(
      principal,
      "greeting",
      { text: "Cloud Agent" },
      "greeting",
    ),
  );
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_append(capabilities,'greeting:run') WHERE workspace_id=$1 AND id=$2",
    [principal.workspace_id, principal.id],
  );
  const actor = await c.identity.current(principal.workspace_id, principal.id);
  const task = await c.service.create(
    actor,
    "greeting",
    { text: "Cloud Agent" },
    "greeting",
  );
  await drain(c);
  const detail = await c.service.detail(actor, task.id);
  assert.equal(detail.task.status, "waiting_approval");
  assert.equal(executions, 0);
  await assert.rejects(
    c.waits.respond(
      { ...actor, workspace_id: "workspace-b" },
      detail.waits[0]!.id,
      { approved: true },
      "cross",
    ),
  );
  const restarted = new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    new DemoEngine(),
  );
  assert.equal(await restarted.tick(), false);
  await c.waits.respond(
    actor,
    detail.waits[0]!.id,
    { approved: true },
    "approve",
  );
  await restarted.tick();
  await restarted.tick();
  assert.equal(await restarted.tick(), false);
  assert.deepEqual((await c.tasks.get(actor, task.id)).result, {
    text: "Hello Cloud Agent",
  });
  assert.equal(
    (
      await c.service.create(
        actor,
        "greeting",
        { text: "Cloud Agent" },
        "greeting",
      )
    ).id,
    task.id,
  );
  assert.equal(executions, 1);
  const rejected = await c.service.create(
    actor,
    "greeting",
    { text: "No" },
    "reject",
  );
  await drain(c);
  const pending = await c.service.detail(actor, rejected.id);
  await c.waits.respond(
    actor,
    pending.waits[0]!.id,
    { approved: false },
    "reject",
  );
  await drain(c);
  assert.equal((await c.tasks.get(actor, rejected.id)).status, "failed");
  assert.equal(executions, 1);
});
