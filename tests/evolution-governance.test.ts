import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { setup, principal, drain } from "./helpers.js";
import { WorkspaceCosts } from "../packages/observability/costs.js";
import { TaskStore } from "../packages/persistence/tasks.js";
import { ExecutionStore } from "../packages/persistence/execution.js";
import { DataRetention } from "../packages/persistence/retention.js";
import type { Module } from "../packages/contracts/index.js";

test("成本核实按当前身份、工作区、版本及命令键审计；租户视图不暴露集群", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const task = await c.service.create(
    principal,
    "text",
    { text: "x", instruction: "echo" },
    "cost-governance",
  );
  const costs = new WorkspaceCosts(c.db, {
    workspaces: { [principal.workspace_id]: 1 },
  });
  await costs.reserve(task, "pending-invocation", 0.9);
  const command = {
    invocation: "pending-invocation",
    expected: "pending",
    amount: 0.2,
    reason: "billing checked",
    receipt: "receipt-1",
  };
  await assert.rejects(
    costs.resolve(
      { ...principal, workspace_id: "workspace-b" },
      "cross",
      command,
    ),
    /COST_NOT_FOUND/,
  );
  await costs.resolve(principal, "resolve", command);
  await costs.resolve(principal, "resolve", command);
  await assert.rejects(
    costs.resolve(principal, "resolve", { ...command, amount: 0.1 }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    costs.resolve(principal, "stale", command),
    /COST_VERSION_CONFLICT/,
  );
  await costs.reserve(task, "next", 0.8);
  assert.equal((await costs.pending(principal.workspace_id)).length, 1);
  const audit = await c.db.pool.query("SELECT * FROM governance_commands");
  assert.equal(audit.rowCount, 1);
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'cost:reconcile') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(
    costs.resolve(principal, "revoked", { ...command, invocation: "next" }),
    /FORBIDDEN|CAPABILITY/,
  );
  await c.operations.heartbeat("cluster-private-name");
  const view = await c.operations.snapshot(principal.workspace_id);
  assert.equal(view.clusterVisible, false);
  assert.deepEqual(view.workers, []);
  assert.ok(
    (await c.operations.snapshot(principal.workspace_id, true)).workers.length,
  );
});

test("过期主体不能读写长期记忆，旧主体快照不绕过撤权", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const memory = await c.memories.put(
    principal,
    "notes",
    "secret context",
    1,
    "memory-fresh",
  );
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'memory:read') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(
    c.memories
      .provider()
      .load({ namespace: "notes" }, principal, new AbortController().signal),
    /FORBIDDEN|CAPABILITY/,
  );
  await c.db.pool.query(
    "UPDATE principals SET enabled=false WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(
    c.memories.remove(principal, memory.id),
    /FORBIDDEN|REVOKED|DISABLED/,
  );
  await assert.rejects(
    c.memories.put(principal, "notes", "stale", 1, "stale"),
    /FORBIDDEN|REVOKED|DISABLED/,
  );
});

test("队列准入原子背压且租户隔离；领取同时匹配执行池和能力标签", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const store = new TaskStore(c.db, c.registry, false, undefined, 1);
  const results = await Promise.allSettled(
    ["one", "two"].map((key) =>
      store.create(principal, "report", { title: "queue", values: [1] }, key),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await store.create(
    { ...principal, workspace_id: "workspace-b" },
    "report",
    { title: "other", values: [1] },
    "other",
  );
  await drain(c);
  const mod: Module = {
    id: "pooled",
    version: "1",
    title: "pooled",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: false, pool: "heavy", labels: ["cpu"] },
    next: () => ({ kind: "complete", result: null }),
  };
  c.registry.register(mod);
  const task = await c.service.create(principal, "pooled", {}, "pooled");
  assert.equal(await c.execution.claim("fixture"), undefined);
  assert.equal(
    await new ExecutionStore(c.db, c.registry, 30_000, {}, "heavy", []).claim(
      "fixture",
    ),
    undefined,
  );
  assert.equal(
    (await new ExecutionStore(c.db, c.registry, 30_000, {}, "heavy", [
      "cpu",
    ]).claim("fixture"))!.id,
    task.id,
  );
});

test("多轮组合扣除历史子步骤、汇总费用不重复，整树退役且保留幂等墓碑", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const mod: Module = {
    id: "rounds",
    version: "1",
    title: "rounds",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: false },
    budget: { maxSteps: 3 },
    next: (_input, steps) => ({
      kind: "children",
      key: `round-${steps.length}`,
      children: [
        { moduleId: "report", input: { title: "child", values: [1] } },
      ],
    }),
  };
  c.registry.register(mod);
  const task = await c.service.create(principal, "rounds", {}, randomUUID());
  await drain(c);
  await c.groups.tick();
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "failed");
  assert.match(
    (await c.tasks.get(principal, task.id)).error!,
    /CHILD_BUDGET|STEP_BUDGET/,
  );
  const children = await c.tasks.children(task.id);
  assert.equal(children.length, 1);
  await c.db.pool.query(
    "UPDATE tasks SET cost_usd=0.5,model_calls=1 WHERE id=ANY($1::uuid[])",
    [[task.id, children[0]!.id]],
  );
  await c.db.pool.query("UPDATE task_groups SET usage=$1 WHERE parent_id=$2", [
    JSON.stringify({ cost_usd: 0.5, model_calls: 1 }),
    task.id,
  ]);
  assert.equal(
    Number(
      (await c.operations.snapshot(principal.workspace_id)).usage.cost_usd,
    ),
    0.5,
  );
  await c.db.pool.query("UPDATE tasks SET updated_at=now()-interval '3 days'");
  const retention = new DataRetention(c.db);
  assert.equal((await retention.run(1, false, "test")).candidates.length, 2);
  assert.equal((await retention.run(1, true, "test")).retired, 2);
  assert.equal((await retention.run(1, true, "test")).retired, 0);
});

import { compensationFixture } from "./fixtures/compensation.js";
test("失败分支收集后经明确审批补偿，重放不重复写入或补偿", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const actor = {
    ...principal,
    capabilities: [...principal.capabilities, "fixture:use"],
  };
  await c.db.pool.query(
    "UPDATE principals SET capabilities=$1 WHERE workspace_id=$2",
    [actor.capabilities, actor.workspace_id],
  );
  let apply = 0,
    compensate = 0;
  c.registry.register(
    compensationFixture({
      apply: async () => ({ receipt: `apply-${++apply}` }),
      compensate: async () => ({ receipt: `compensate-${++compensate}` }),
    }),
  );
  c.registry.register({
    id: "failed-child",
    version: "1",
    title: "failure",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: false },
    next: () => {
      throw new Error("fixture failure");
    },
  });
  const input = {
    reference: "fixture",
    children: [{ moduleId: "failed-child", input: {} }],
  };
  const task = await c.service.create(
    actor,
    "fixture-compensation",
    input,
    "compensation",
  );
  await drain(c);
  await c.groups.tick();
  await drain(c);
  assert.equal((await c.tasks.get(actor, task.id)).status, "waiting_approval");
  assert.equal(apply, 1);
  assert.equal(compensate, 0);
  const detail = await c.service.detail(actor, task.id);
  await c.service.respond(
    actor,
    detail.waits[0]!.id,
    { approved: true },
    "approve-compensation",
  );
  await drain(c);
  assert.equal((await c.tasks.get(actor, task.id)).status, "succeeded");
  assert.equal(compensate, 1);
  assert.equal(
    (
      await c.service.create(
        actor,
        "fixture-compensation",
        input,
        "compensation",
      )
    ).id,
    task.id,
  );
  assert.equal(apply, 1);
  assert.equal(compensate, 1);
});

test("重试父任务后续失败不重开已完成的子任务组", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register({
    id: "after-group",
    version: "1",
    title: "fixture",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: false },
    next: (_input, steps) => {
      if (!steps.length)
        return {
          kind: "children",
          key: "batch",
          children: [
            { moduleId: "report", input: { title: "child", values: [1] } },
          ],
        };
      throw new Error("failure after successful group");
    },
  });
  const task = await c.service.create(
    principal,
    "after-group",
    {},
    "retry-group",
  );
  await drain(c);
  await c.groups.tick();
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "failed");
  await c.service.retry(principal, task.id);
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT settled FROM task_groups WHERE parent_id=$1",
        [task.id],
      )
    ).rows[0].settled,
    true,
  );
});
