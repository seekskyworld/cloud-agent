/** 故障窗口、权限变化及副作用测试覆盖运行时的不变量。 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createContainer, type Container } from "../apps/container.js";
import {
  Problem,
  type Json,
  type Module,
  type Tool,
} from "../packages/contracts/index.js";
import { Worker } from "../packages/runtime/worker.js";
import { modelCheckpointHash } from "../packages/runtime/model-request.js";
import { sourceDigest } from "../packages/contracts/source.js";
import { DemoEngine } from "../adapters/engine-pi/index.js";
import { applyEffect } from "./fixtures/effects.js";
import { setup, principal, drain, expired } from "./helpers.js";
let c: Container;
beforeEach(async () => {
  c = await setup();
});
afterEach(async () => {
  await c?.db.close();
});
const create = (
  moduleId = "report",
  input = { title: "指标", values: [1, 2, 3] } as
    Record<string, never> | { title: string; values: number[] },
) => c.tasks.create(principal, moduleId, input, randomUUID());
function custom(tool: Tool): Module {
  return {
    id: "fixture",
    version: "1",
    title: "fixture",
    description: "test",
    capability: "report:run",
    input: z.object({}).strict(),
    example: {},
    tools: [tool],
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : { kind: "tool", key: "action", name: tool.name, input: {} };
    },
  };
}

test("相同请求并发提交只产生一个任务，参数冲突被拒绝", async () => {
  const input = { title: "统计", values: [1, 2] };
  const [a, b] = await Promise.all([
    c.tasks.create(principal, "report", input, "same"),
    c.tasks.create(principal, "report", input, "same"),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    c.tasks.create(principal, "report", { ...input, values: [3] }, "same"),
    (e: unknown) => e instanceof Problem && e.code === "IDEMPOTENCY_CONFLICT",
  );
  await drain(c);
  const result = await c.tasks.get(principal, a.id);
  assert.equal(result.status, "succeeded");
  assert.equal((result.result as { sum: number }).sum, 3);
});
test("模型结果检查点在租约失效后复用，不重复调用模型", async () => {
  const fixture: Module = {
    id: "checkpoint-fixture",
    version: "1",
    title: "checkpoint",
    description: "checkpoint",
    capability: "report:run",
    runtime: { model: true },
    input: z.object({}),
    example: {},
    tools: [],
    next(_input, steps) {
      const step = steps[0];
      return step
        ? { kind: "complete", result: step.output! }
        : {
            kind: "model",
            key: "extract",
            request: {
              instructions: "extract",
              messages: [{ role: "user", text: "source" }],
              tools: [],
              checkpoint: {
                key: "extract-v1",
                sourceDigest: sourceDigest("source"),
              },
            },
          };
    },
  };
  c.registry.register(fixture);
  const task = await c.service.create(principal, fixture.id, {}, "checkpoint");
  const claimed = (await c.execution.claim("demo"))!;
  const action = fixture.next({}, []);
  assert.equal(action.kind, "model");
  if (action.kind !== "model") throw new Error("checkpoint action missing");
  const step = await c.execution.prepare(claimed, action);
  await c.execution.begin(claimed, step);
  const hash = modelCheckpointHash(
    claimed.config_hash,
    "demo:echo-v1",
    action.request,
  );
  assert.ok(hash);
  await c.execution.checkpointModel(
    claimed,
    step,
    {
      text: "checked",
      calls: [],
      costUsd: 0,
      costEstimated: false,
      inputTokens: 1,
      outputTokens: 1,
    },
    hash,
    12,
    0,
  );
  await c.db.pool.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [task.id],
  );
  const recovered = (await c.execution.claim("demo"))!;
  const recoveredStep = (await c.execution.steps(task.id))[0]!;
  assert.equal(
    await c.execution.resumeCheckpoint(recovered, recoveredStep, hash),
    true,
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});
test("不同工作区无法读取任务、会话或取消", async () => {
  const task = await create();
  const other = { ...principal, workspace_id: "workspace-b" };
  await assert.rejects(c.tasks.get(other, task.id));
  await assert.rejects(c.tasks.cancel(other, task.id));
  await assert.rejects(c.service.conversation(other, task.conversation_id));
});
test("输入等待跨 Worker 实例恢复，重复响应不重复执行", async () => {
  const task = await c.tasks.create(
    principal,
    "report",
    { values: [10, 20] },
    randomUUID(),
  );
  await drain(c);
  const detail = await c.tasks.detail(principal, task.id);
  assert.equal(detail.task.status, "waiting_input");
  const wait = detail.waits[0]!;
  await c.waits.respond(principal, wait.id, { title: "恢复报告" }, "response");
  await c.waits.respond(principal, wait.id, { title: "恢复报告" }, "response");
  const worker = new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    new DemoEngine(),
  );
  for (let i = 0; i < 5; i++) await worker.tick();
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  const events = await c.tasks.events(principal, task.id, "0");
  assert.equal(events.filter((e) => e.type === "wait.consumed").length, 1);
});
test("工具写入必须确认，并保存独立副作用回执", async () => {
  const task = await c.tasks.create(
    principal,
    "effect",
    { value: 10 },
    randomUUID(),
  );
  await drain(c);
  const detail = await c.tasks.detail(principal, task.id);
  assert.equal(detail.task.status, "waiting_approval");
  assert.equal(
    (await c.db.pool.query("SELECT * FROM fixture_effects")).rowCount,
    0,
  );
  await c.waits.respond(
    principal,
    detail.waits[0]!.id,
    { approved: true },
    "approve",
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT result->>'value' AS value FROM fixture_effects",
      )
    ).rows[0].value,
    "10",
  );
});
test("确认后撤销写权限，恢复不能提交", async () => {
  const task = await c.tasks.create(
    principal,
    "effect",
    { value: 10 },
    randomUUID(),
  );
  await drain(c);
  const detail = await c.tasks.detail(principal, task.id);
  await c.waits.respond(
    principal,
    detail.waits[0]!.id,
    { approved: true },
    "approve",
  );
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'effect:write') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).error, "FORBIDDEN");
  assert.equal(
    (await c.db.pool.query("SELECT * FROM fixture_effects")).rowCount,
    0,
  );
});
test("副作用已提交而结果未落库时崩溃，恢复复用同一动作编号", async () => {
  const task = await c.tasks.create(
    principal,
    "effect",
    { value: 15 },
    randomUUID(),
  );
  await drain(c);
  await c.waits.respond(
    principal,
    (await c.tasks.detail(principal, task.id)).waits[0]!.id,
    { approved: true },
    "approve",
  );
  const claim = (await c.execution.claim("test"))!;
  const step = (await c.execution.steps(task.id))[0]!;
  await c.execution.begin(claim, step);
  assert.equal(step.request.kind, "tool");
  if (step.request.kind !== "tool") throw new Error("Expected tool");
  await applyEffect(c.db, step.request.input, {
    principal,
    taskId: task.id,
    runId: claim.run_id!,
    invocationId: step.id,
    idempotencyKey: step.id,
    signal: new AbortController().signal,
  });
  await expired(c, claim);
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  assert.equal(
    (await c.db.pool.query("SELECT * FROM fixture_effects")).rowCount,
    1,
  );
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT result->>'value' AS value FROM fixture_effects",
      )
    ).rows[0].value,
    "15",
  );
});
test("过期 Worker 无法覆盖新租约，多个 Worker 只领取一次", async () => {
  const task = await create();
  const claims = await Promise.all([
    c.execution.claim("one"),
    c.execution.claim("two"),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  await expired(c, old);
  const current = (await c.execution.claim("new"))!;
  await assert.rejects(
    c.execution.complete(old, { bad: true }, "late"),
    (e: unknown) => e instanceof Problem && e.code === "LEASE_LOST",
  );
  await c.execution.complete(current, { ok: true }, "current");
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});
test("取消与迟到提交：旧 Worker 失去提交权，事件保留", async () => {
  const task = await create();
  const claim = (await c.execution.claim("test"))!;
  await c.tasks.cancel(principal, task.id);
  await assert.rejects(c.execution.complete(claim, { late: true }, "late"));
  assert.equal((await c.tasks.get(principal, task.id)).status, "cancelled");
});
test("非幂等工具出现未知结果后不自动重复执行", async () => {
  let calls = 0;
  c.registry.register(
    custom({
      name: "fixture.write",
      version: "1",
      description: "test",
      input: z.object({}),
      output: z.object({}),
      capability: "report:run",
      effect: "unsafe_write",
      timeoutMs: 1000,
      async execute() {
        calls++;
        throw new Error("connection lost");
      },
    }),
  );
  const task = await c.tasks.create(principal, "fixture", {}, randomUUID());
  await drain(c);
  assert.equal(calls, 1);
  assert.equal(
    (await c.tasks.get(principal, task.id)).status,
    "waiting_external",
  );
  await assert.rejects(
    c.tasks.retry(principal, task.id),
    (e: unknown) =>
      e instanceof Problem && e.code === "MANUAL_RECONCILIATION_REQUIRED",
  );
  await drain(c);
  assert.equal(calls, 1);
});
test("可对账工具只查询原动作，不重复发送", async () => {
  let calls = 0;
  let queries = 0;
  c.registry.register(
    custom({
      name: "fixture.write",
      version: "1",
      description: "test",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      capability: "report:run",
      effect: "reconcilable_write",
      timeoutMs: 1000,
      async execute() {
        calls++;
        return { kind: "unknown", reconciliationRef: "receipt" };
      },
      async reconcile() {
        queries++;
        return { kind: "succeeded", output: { ok: true } };
      },
    }),
  );
  const task = await c.tasks.create(principal, "fixture", {}, randomUUID());
  await drain(c);
  await c.tasks.retry(principal, task.id);
  await drain(c);
  assert.equal(calls, 1);
  assert.equal(queries, 1);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});
test("拒绝审批和等待过期都不能执行业务工具", async () => {
  const task = await c.tasks.create(
    principal,
    "report",
    { values: [1] },
    randomUUID(),
  );
  await drain(c);
  await c.db.pool.query(
    "UPDATE waits SET expires_at=now()-interval '1 second' WHERE task_id=$1",
    [task.id],
  );
  await c.waits.expire();
  assert.equal((await c.tasks.get(principal, task.id)).error, "WAIT_EXPIRED");
  await assert.rejects(
    c.waits.respond(
      principal,
      (await c.tasks.detail(principal, task.id)).waits[0]!.id,
      { title: "迟到" },
      "late",
    ),
  );
});
test("同版本配置变化阻止静默恢复", async () => {
  const task = await create();
  c.registry.get("report").budget = { maxSteps: 1 };
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "queued");
  assert.equal(
    (await c.service.list(principal, 0))[0]!.compatibility,
    "requires_compatible_worker",
  );
  c.registry.get("report").budget = undefined;
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});
test("定时调度并发只创建一次，撤权自动停用", async () => {
  const schedule = await c.schedules.create(
    principal,
    "report",
    { title: "定时", values: [1] },
    60,
  );
  await c.db.pool.query(
    "UPDATE schedules SET next_at=now()-interval '1 second' WHERE id=$1",
    [schedule.id],
  );
  await Promise.all([c.schedules.tick(), c.schedules.tick()]);
  assert.equal((await c.tasks.list(principal)).length, 1);
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'schedule:write')",
  );
  await c.db.pool.query(
    "UPDATE schedules SET next_at=now()-interval '1 second'",
  );
  await c.schedules.tick();
  assert.equal((await c.schedules.list(principal))[0].enabled, false);
});
test("模型示例使用同一运行时，并明确标识本地演示输出", async () => {
  const task = await c.tasks.create(
    principal,
    "text",
    { text: "待处理文本", instruction: "概括" },
    randomUUID(),
  );
  await drain(c);
  const result = await c.tasks.get(principal, task.id);
  assert.equal(result.status, "succeeded");
  assert.match((result.result as { text: string }).text, /未调用模型/);
  assert.equal(result.model_calls, 1);
});

test("拒绝确认后显式重试仍不能执行，过期确认也不能复用", async () => {
  const task = await c.tasks.create(
    principal,
    "effect",
    { value: 5 },
    randomUUID(),
  );
  await drain(c);
  await c.waits.respond(
    principal,
    (await c.tasks.detail(principal, task.id)).waits[0]!.id,
    { approved: false },
    "deny",
  );
  await assert.rejects(
    () => c.tasks.retry(principal, task.id),
    /APPROVAL_REJECTED/,
  );
  assert.equal((await c.tasks.get(principal, task.id)).status, "failed");
  assert.equal(
    (await c.db.pool.query("SELECT * FROM fixture_effects")).rowCount,
    0,
  );
  const second = await c.tasks.create(
    principal,
    "effect",
    { value: 5 },
    randomUUID(),
  );
  await drain(c);
  await c.waits.respond(
    principal,
    (await c.tasks.detail(principal, second.id)).waits[0]!.id,
    { approved: true },
    "approve-expired",
  );
  await c.db.pool.query(
    "UPDATE waits SET expires_at=now()-interval '1 second' WHERE task_id=$1",
    [second.id],
  );
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, second.id)).error,
    "APPROVAL_EXPIRED",
  );
});
test("确认绑定参数摘要，工具参数改变后不能复用确认", async () => {
  const task = await c.tasks.create(
    principal,
    "effect",
    { value: 5 },
    randomUUID(),
  );
  await drain(c);
  await c.waits.respond(
    principal,
    (await c.tasks.detail(principal, task.id)).waits[0]!.id,
    { approved: true },
    "binding",
  );
  const step = (await c.execution.steps(task.id))[0]!;
  if (step.request.kind !== "tool") throw new Error("tool required");
  const altered = {
    ...step.request,
    input: { ...step.request.input, value: 100 },
  };
  const { fingerprint } = await import("../packages/persistence/database.js");
  await c.db.pool.query(
    "UPDATE steps SET request=$2,request_hash=$3 WHERE id=$1",
    [step.id, JSON.stringify(altered), fingerprint(altered)],
  );
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, task.id)).error,
    "APPROVAL_BINDING_CHANGED",
  );
  assert.equal(
    (await c.db.pool.query("SELECT * FROM fixture_effects")).rowCount,
    0,
  );
});
function externalModule(
  waitKind: "input" | "external" = "external",
  schema = {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  } as Json,
): Module {
  return {
    id: "external",
    version: "1",
    title: "外部结果",
    description: "fixture",
    capability: "report:run",
    input: z.object({}).strict(),
    example: {},
    tools: [],
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : {
            kind: "wait",
            key: "external-result",
            waitKind,
            reason: "等待结果",
            schema,
            expiresInMs: 60_000,
          };
    },
  };
}
for (const kind of ["input", "external"] as const)
  test(`2020-12 ${kind} 等待恢复并拒绝不合法的元组响应`, async () => {
    const schema = z
      .json()
      .parse(
        z.toJSONSchema(
          z.object({ value: z.tuple([z.string(), z.number()]) }).strict(),
        ),
      );
    c.registry.register(externalModule(kind, schema));
    for (const valid of [false, true]) {
      const task = await c.tasks.create(
        principal,
        "external",
        {},
        randomUUID(),
      );
      await drain(c);
      const response = { value: valid ? ["item", 1] : [1, "item"] };
      if (kind === "input") {
        const [wait] = (
          await c.db.pool.query<{ id: string }>(
            "SELECT id FROM waits WHERE task_id=$1 AND status='pending'",
            [task.id],
          )
        ).rows;
        assert.ok(wait);
        if (!valid) {
          await assert.rejects(
            c.waits.respond(principal, wait.id, response, randomUUID()),
            /INVALID_WAIT_RESPONSE/,
          );
          assert.equal(
            (await c.tasks.get(principal, task.id)).status,
            "waiting_input",
          );
          continue;
        }
        await c.waits.respond(principal, wait.id, response, randomUUID());
      } else {
        await c.signals.receive(
          principal,
          task.id,
          "external-result",
          response,
          randomUUID(),
        );
      }
      await drain(c);
      const result = await c.tasks.get(principal, task.id);
      assert.equal(result.status, valid ? "succeeded" : "failed");
      if (valid) assert.deepEqual(result.result, response);
      else assert.equal(result.error, "INVALID_EXTERNAL_RESPONSE");
    }
  });
test("外部回调提前到达并重复发送，等待创建后只消费一次", async () => {
  c.registry.register(externalModule());
  const task = await c.tasks.create(principal, "external", {}, randomUUID());
  await c.signals.receive(
    principal,
    task.id,
    "external-result",
    { value: 42 },
    "external-event",
  );
  await c.signals.receive(
    principal,
    task.id,
    "external-result",
    { value: 42 },
    "external-event",
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  assert.deepEqual((await c.tasks.get(principal, task.id)).result, {
    value: 42,
  });
  assert.equal(
    (await c.tasks.events(principal, task.id, "0")).filter(
      (e) => e.type === "signal.consumed",
    ).length,
    1,
  );
});
test("晚到回调能唤醒已等待任务，取消任务拒绝新回调", async () => {
  c.registry.register(externalModule());
  const task = await c.tasks.create(principal, "external", {}, randomUUID());
  await drain(c);
  await c.signals.receive(
    principal,
    task.id,
    "external-result",
    { value: 7 },
    "late-event",
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  const cancelled = await c.tasks.create(
    principal,
    "external",
    {},
    randomUUID(),
  );
  await c.tasks.cancel(principal, cancelled.id);
  await assert.rejects(
    c.signals.receive(
      principal,
      cancelled.id,
      "external-result",
      { value: 8 },
      "cancel-event",
    ),
  );
});
test("工具次数预算阻止无限执行，坏结果不会作为成功产物", async () => {
  const tool: Tool = {
    name: "fixture.bad",
    version: "1",
    description: "test",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    capability: "report:run",
    effect: "read",
    timeoutMs: 100,
    async execute() {
      return { kind: "succeeded", output: { not_ok: true } };
    },
  };
  const module = custom(tool);
  c.registry.register(module);
  const task = await c.tasks.create(principal, "fixture", {}, randomUUID());
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, task.id)).error,
    "INVALID_TOOL_OUTPUT",
  );
  const loop = {
    ...custom({
      ...tool,
      async execute() {
        return { kind: "succeeded" as const, output: { ok: true } };
      },
    }),
    id: "loop",
    budget: { maxToolCalls: 1 },
    next(
      _input: unknown,
      steps: import("../packages/contracts/index.js").Step[],
    ) {
      return {
        kind: "tool" as const,
        key: `step-${steps.length}`,
        name: tool.name,
        input: {},
      };
    },
  };
  c.registry.register(loop);
  const infinite = await c.tasks.create(principal, "loop", {}, randomUUID());
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, infinite.id)).error,
    "EXECUTION_BUDGET_EXCEEDED",
  );
});
test("无响应工具达到超时后释放 Worker，写入保留未知", async () => {
  c.registry.register(
    custom({
      name: "fixture.hang",
      version: "1",
      description: "test",
      input: z.object({}),
      output: z.object({}),
      capability: "report:run",
      effect: "unsafe_write",
      timeoutMs: 30,
      execute: () => new Promise(() => {}),
    }),
  );
  const task = await c.tasks.create(principal, "fixture", {}, randomUUID());
  const start = Date.now();
  await drain(c);
  assert.ok(Date.now() - start < 2000);
  assert.equal(
    (await c.tasks.get(principal, task.id)).status,
    "waiting_external",
  );
});
test("资源撤权后不得把旧结果送给模型或读取产物", async () => {
  let allowed = true;
  const check = async () => {
    if (!allowed) throw new Problem(403, "RESOURCE_ACCESS_CHANGED");
  };
  const module: Module = {
    ...custom({
      name: "fixture.resource",
      version: "1",
      description: "受控资源",
      input: z.object({}),
      output: z.object({ text: z.string() }),
      capability: "report:run",
      effect: "read",
      timeoutMs: 1000,
      async execute() {
        return { kind: "succeeded", output: { text: "私有内容" } };
      },
    }),
    id: "private-resource",
    validateContext: check,
    authorizeRead: check,
    next(_input, steps) {
      if (!steps.length)
        return {
          kind: "tool",
          key: "read",
          name: "fixture.resource",
          input: {},
        };
      if (steps.length === 1)
        return {
          kind: "model",
          key: "generate",
          request: {
            instructions: "概括资源",
            messages: [
              { role: "user", text: JSON.stringify(steps[0]!.output) },
            ],
            tools: [],
          },
        };
      return { kind: "complete", result: steps[1]!.output! };
    },
  };
  c.registry.register(module);
  const task = await c.tasks.create(principal, module.id, {}, randomUUID());
  await c.worker.tick();
  allowed = false;
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, task.id)).error,
    "RESOURCE_ACCESS_CHANGED",
  );
  assert.equal((await c.tasks.get(principal, task.id)).model_calls, 0);
  await assert.rejects(c.service.detail(principal, task.id));
});

test("只读瞬时故障退避重试，尝试上限终止持续失败", async () => {
  let count = 0;
  const tool: Tool = {
    name: "fixture.flaky",
    version: "1",
    description: "fixture",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    capability: "report:run",
    effect: "read",
    timeoutMs: 100,
    async execute() {
      count++;
      return count === 1
        ? { kind: "retryable", code: "TEMPORARY" }
        : { kind: "succeeded", output: { ok: true, internal: "must-strip" } };
    },
  };
  c.registry.register(custom(tool));
  const task = await c.tasks.create(principal, "fixture", {}, randomUUID());
  await c.worker.tick();
  assert.equal(
    (await c.tasks.get(principal, task.id)).status,
    "retry_scheduled",
  );
  await c.db.pool.query("UPDATE tasks SET available_at=now() WHERE id=$1", [
    task.id,
  ]);
  await drain(c);
  assert.equal(count, 2);
  assert.deepEqual((await c.tasks.get(principal, task.id)).result, {
    ok: true,
  });
  const broken = custom({
    ...tool,
    name: "fixture.broken",
    async execute() {
      return { kind: "retryable", code: "TEMPORARY" };
    },
  });
  broken.id = "broken";
  broken.budget = { maxAttempts: 1 };
  c.registry.register(broken);
  const failed = await c.tasks.create(principal, "broken", {}, randomUUID());
  await c.worker.tick();
  await c.db.pool.query("UPDATE tasks SET available_at=now() WHERE id=$1", [
    failed.id,
  ]);
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, failed.id)).error,
    "ATTEMPT_BUDGET_EXCEEDED",
  );
});
test("心跳只能延长有效租约，续租失败不能复活过期任务", async () => {
  const task = await create();
  const claim = (await c.execution.claim("test"))!;
  assert.equal(await c.execution.heartbeat(claim), true);
  await expired(c, claim);
  assert.equal(await c.execution.heartbeat(claim), false);
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
});
test("回调权限、冲突和坏输入被拒绝或明确失败", async () => {
  c.registry.register(externalModule());
  const task = await c.tasks.create(principal, "external", {}, randomUUID());
  await assert.rejects(
    c.signals.receive(
      { ...principal, capabilities: [] },
      task.id,
      "external-result",
      { value: 1 },
      "no-auth",
    ),
  );
  await c.signals.receive(
    principal,
    task.id,
    "external-result",
    { wrong: 1 },
    "bad-input",
  );
  await assert.rejects(
    c.signals.receive(
      principal,
      task.id,
      "external-result",
      { value: 1 },
      "bad-input",
    ),
  );
  await assert.rejects(
    c.signals.receive(
      principal,
      task.id,
      "external-result",
      { value: 1 },
      "another-event",
    ),
  );
  await drain(c);
  assert.equal(
    (await c.tasks.get(principal, task.id)).error,
    "INVALID_EXTERNAL_RESPONSE",
  );
});
test("同一会话可包含多个独立任务，停用定时器不会继续发任务", async () => {
  const first = await create();
  await c.tasks.create(
    principal,
    "report",
    { title: "第二项", values: [2] },
    randomUUID(),
    first.conversation_id,
  );
  await drain(c);
  assert.equal(
    (await c.service.conversation(principal, first.conversation_id)).length,
    4,
  );
  const schedule = await c.schedules.create(
    principal,
    "report",
    { title: "停止", values: [1] },
    60,
  );
  await c.schedules.remove(principal, schedule.id);
  await c.db.pool.query("UPDATE schedules SET next_at=now()");
  await c.schedules.tick();
  assert.equal((await c.tasks.list(principal)).length, 2);
});

test("模块和引擎可整体注入，移除模块不阻塞其他任务列表", async () => {
  const previous = await create();
  const oldSchedule = await c.schedules.create(
    principal,
    "report",
    { title: "旧模块", values: [1] },
    60,
  );
  await c.db.pool.query("UPDATE schedules SET next_at=now() WHERE id=$1", [
    oldSchedule.id,
  ]);
  const replacement = custom({
    name: "fixture.echo",
    version: "1",
    description: "fixture",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    capability: "report:run",
    effect: "read",
    timeoutMs: 1000,
    async execute() {
      return { kind: "succeeded", output: { ok: true } };
    },
  });
  const engine = new DemoEngine();
  const isolated = await createContainer(c.config, {
    modules: [replacement],
    engine,
    profile: "extension-test-v1",
  });
  try {
    assert.deepEqual(
      isolated.registry.list().map((module) => module.id),
      ["fixture"],
    );
    assert.equal(isolated.engine, engine);
    await isolated.schedules.tick();
    assert.equal((await isolated.schedules.list(principal))[0].enabled, false);
    const list = await isolated.service.list(principal, 0);
    assert.equal(
      list.find((task) => task.id === previous.id)?.available,
      false,
    );
    await assert.rejects(isolated.service.detail(principal, previous.id), {
      code: "MODULE_NOT_AVAILABLE",
    });
    const task = await isolated.tasks.create(
      principal,
      "fixture",
      {},
      randomUUID(),
    );
    await drain(isolated);
    assert.equal(
      (await isolated.tasks.get(principal, task.id)).status,
      "succeeded",
    );
  } finally {
    await isolated.db.close();
  }
});

test("读取授权收到原始步骤而非内核猜测的数据结构，产物撤权同样生效", async () => {
  let allowed = true;
  const module = custom({
    name: "fixture.opaque",
    version: "1",
    description: "不透明输出",
    input: z.object({}),
    output: z.object({ resourceKey: z.string() }),
    capability: "report:run",
    effect: "read",
    timeoutMs: 1000,
    async execute() {
      return { kind: "succeeded", output: { resourceKey: "resource-42" } };
    },
  });
  module.authorizeRead = async (_task, _principal, _signal, steps) => {
    assert.equal(
      (steps[0]!.output as { resourceKey: string }).resourceKey,
      "resource-42",
    );
    if (!allowed) throw new Problem(403, "RESOURCE_ACCESS_CHANGED");
  };
  c.registry.register(module);
  const task = await c.tasks.create(principal, module.id, {}, randomUUID());
  await drain(c);
  const detail = await c.service.detail(principal, task.id);
  assert.equal(detail.task.status, "succeeded");
  allowed = false;
  await assert.rejects(c.service.artifact(principal, detail.artifacts[0]!.id), {
    code: "RESOURCE_ACCESS_CHANGED",
  });
});
