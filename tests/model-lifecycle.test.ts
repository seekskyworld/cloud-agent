/** 隔离 PostgreSQL 和不合作模型复现取消、接管、未知容量与迟到回执。 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { setup, principal } from "./helpers.js";
import { Worker } from "../packages/runtime/worker.js";
import { ModelRequestStore } from "../packages/persistence/model-requests.js";
import { DataRetention } from "../packages/persistence/retention.js";
import { ModelProfiles } from "../packages/runtime/models.js";
import { modelDeadline } from "../packages/runtime/model-deadline.js";
import { prepareModelRequest } from "../packages/runtime/model-request.js";
import type {
  ModelEngine,
  ModelRequest,
  ModelTurn,
  Module,
} from "../packages/contracts/index.js";
const output: ModelTurn = {
  text: "result",
  calls: [],
  costUsd: 0.1,
  costEstimated: false,
  inputTokens: 1,
  outputTokens: 1,
};
const request: ModelRequest = {
  instructions: "fixture",
  messages: [],
  tools: [],
  timeoutMs: 1000,
};
function moduleFor(options: Partial<ModelRequest> = {}): Module {
  return {
    id: "model-lifecycle",
    version: "1",
    title: "Lifecycle",
    description: "test",
    capability: "report:run",
    runtime: { model: true },
    input: z.object({}),
    example: {},
    tools: [],
    next: (_input, steps) =>
      steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : { kind: "model", key: "model", request: { ...request, ...options } },
  };
}
function worker(c: Awaited<ReturnType<typeof setup>>, engine: ModelEngine) {
  return new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    engine,
    undefined,
    undefined,
    undefined,
    c.costs,
  );
}
async function row(c: Awaited<ReturnType<typeof setup>>) {
  return (
    await c.db.pool.query(
      "SELECT * FROM model_requests ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
}
function stalled() {
  let resolve!: (v: ModelTurn) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const engine: ModelEngine = {
    id: "demo:echo-v1",
    capabilities: {
      progress: true,
      structuredOutput: "validated",
      maxOutputTokens: 100,
    },
    lifecycle: {
      resourceId: "fixture-shared",
      unknownLimit: 1,
      quarantineMs: 60000,
    },
    next: async () => {
      started();
      return new Promise<ModelTurn>((r) => (resolve = r));
    },
  };
  return { engine, ready, finish: () => resolve(output) };
}
test("取消通知立即中止等待，未知调用隔离跨 Worker，迟到回执不恢复任务", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(moduleFor());
  const fake = stalled();
  const w = worker(c, fake.engine);
  const task = await c.service.create(
    principal,
    "model-lifecycle",
    {},
    "cancel-model",
  );
  const running = w.tick();
  await fake.ready;
  const before = Date.now();
  await c.service.cancel(principal, task.id);
  await running;
  assert.ok(Date.now() - before < 2000);
  assert.equal((await row(c)).state, "unknown");
  await c.service.create(principal, "model-lifecycle", {}, "other-model");
  await worker(c, fake.engine).tick();
  const counts = (
    await c.db.pool.query("SELECT model_calls FROM tasks WHERE id<>$1", [
      task.id,
    ])
  ).rows[0];
  assert.equal(counts.model_calls, 0);
  await c.db.pool.query(
    "UPDATE tasks SET updated_at=now()-interval '31 days' WHERE id=$1",
    [task.id],
  );
  const retention = new DataRetention(c.db);
  for (const state of ["running", "cancelling", "unknown"]) {
    await c.db.pool.query(
      "UPDATE model_requests SET state=$1 WHERE task_id=$2",
      [state, task.id],
    );
    assert.equal((await retention.run(30, true, "test")).retired, 0);
  }
  fake.finish();
  for (let i = 0; i < 50 && (await row(c)).state !== "completed"; i++)
    await delay(10);
  assert.equal((await row(c)).state, "completed");
  assert.equal((await c.tasks.get(principal, task.id)).status, "cancelled");
  assert.equal((await c.execution.steps(task.id))[0]!.output, null);
  assert.equal((await retention.run(30, true, "test")).retired, 1);
});
test("Worker 丢失租约后旧代通知不终止新调用，同步骤不能立即重发", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(moduleFor());
  const task = await c.service.create(
    principal,
    "model-lifecycle",
    {},
    "orphan",
  );
  const old = await c.execution.claim("demo:echo-v1");
  assert.ok(old);
  const action = moduleFor().next({}, []);
  assert.equal(action.kind, "model");
  if (action.kind !== "model") return;
  const step = await c.execution.prepare(old, action);
  await c.execution.begin(old, step);
  const store = new ModelRequestStore(c.db);
  await store.begin(
    old,
    step,
    "demo:echo-v1",
    { resourceId: "fixture-shared" },
    Date.now() + 60000,
    "hash",
  );
  await c.db.pool.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [task.id],
  );
  let calls = 0;
  const engine: ModelEngine = {
    id: "demo:echo-v1",
    lifecycle: { resourceId: "fixture-shared" },
    next: async () => {
      calls++;
      return output;
    },
  };
  await worker(c, engine).tick();
  assert.equal(calls, 0);
  assert.equal((await row(c)).state, "unknown");
  assert.equal((await c.tasks.get(principal, task.id)).model_calls, 1);
  await assert.rejects(
    store.begin(
      old,
      step,
      engine.id,
      { resourceId: "fixture-shared" },
      Date.now() + 1000,
      "hash",
    ),
    { code: "LEASE_LOST" },
  );
  await c.db.pool.query(
    "UPDATE model_requests SET quarantine_until=now()-interval '1 second'",
  );
  await c.db.pool.query("UPDATE tasks SET available_at=now() WHERE id=$1", [
    task.id,
  ]);
  await worker(c, engine).tick();
  assert.equal(calls, 1);
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT state FROM model_requests ORDER BY created_at LIMIT 1",
      )
    ).rows[0].state,
    "unknown",
  );
});
test("取消控制使用独立信号；transport_closed 和状态丢失均保留未知，确认未开始才释放", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(moduleFor({ firstOutputTimeoutMs: 25 }));
  const fake = stalled();
  let cancelCalls = 0;
  let state: "unknown" | "not_started" = "unknown";
  fake.engine.control = {
    cancel: async (_ref, signal) => {
      assert.equal(signal.aborted, false);
      cancelCalls++;
      return { state: "transport_closed" };
    },
    status: async () => ({ state }),
  };
  const w = worker(c, fake.engine);
  await c.service.create(principal, "model-lifecycle", {}, "control");
  await w.tick();
  assert.equal((await row(c)).state, "unknown");
  assert.equal(cancelCalls, 1);
  await c.db.pool.query("UPDATE model_requests SET reconciled_at=NULL");
  await w.modelLifecycle.reconcile(() => fake.engine);
  assert.equal((await row(c)).state, "unknown");
  state = "not_started";
  await c.db.pool.query("UPDATE model_requests SET reconciled_at=NULL");
  await w.modelLifecycle.reconcile(() => fake.engine);
  assert.equal((await row(c)).state, "not_started");
  fake.finish();
  await delay(20);
  assert.equal((await row(c)).state, "not_started");
});
test("并发准入共享资源，未知费用预留不会被部分回执当作零费用释放", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(moduleFor());
  const store = new ModelRequestStore(c.db);
  const admissions = [];
  for (let i = 0; i < 2; i++) {
    await c.service.create(principal, "model-lifecycle", {}, `parallel-${i}`);
    const task = await c.execution.claim("demo:echo-v1");
    assert.ok(task);
    const action = moduleFor().next({}, []);
    if (action.kind !== "model") throw Error();
    const step = await c.execution.prepare(task, action);
    admissions.push({ task, step });
  }
  const results = await Promise.allSettled(
    admissions.map(({ task, step }) =>
      store.begin(
        task,
        step,
        "fixture",
        { resourceId: "shared", concurrency: 1 },
        Date.now() + 10000,
        "hash",
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const record = await row(c);
  await c.db.pool.query(
    "INSERT INTO cost_reservations(scope,invocation,workspace_id,task_id,period,reserved) VALUES('workspace:workspace-a',$1,'workspace-a',$2,current_date,1)",
    [record.cost_invocation, record.task_id],
  );
  await store.uncertain(record.id);
  await store.receipt(record.id, {
    state: "transport_closed",
    usage: { costUsd: 0.2, complete: false, estimated: true },
  });
  assert.equal((await row(c)).usage_complete, false);
  assert.equal((await c.costs.pending("workspace-a"))[0].reserved, 1);
  await assert.rejects(
    store.receipt(record.id, {
      state: "completed",
      usage: { costUsd: -1, complete: true, estimated: false },
    }),
  );
});
test("首包和停顿超时不受心跳或后续增量延长总时限影响", async () => {
  const controller = new AbortController();
  const first = modelDeadline(controller.signal, Date.now() + 1000, 20, 20);
  first.start();
  await delay(35);
  assert.equal(first.failure()?.code, "MODEL_FIRST_OUTPUT_TIMEOUT");
  first.close();
  const idle = modelDeadline(controller.signal, Date.now() + 1000, 100, 20);
  idle.start();
  idle.progress();
  await delay(35);
  assert.equal(idle.failure()?.code, "MODEL_IDLE_TIMEOUT");
  idle.close();
  const total = modelDeadline(controller.signal, Date.now() + 45, 100, 100);
  total.start();
  const timer = setInterval(() => total.progress(), 5);
  await delay(65);
  clearInterval(timer);
  assert.equal(total.failure()?.code, "MODEL_EXECUTION_TIMEOUT");
  total.close();
});
test("旧代通知不能取消新租约，伪造通知也必须重读数据库", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(moduleFor());
  const fake = stalled();
  let signal: AbortSignal | undefined;
  const next = fake.engine.next;
  fake.engine.next = (r, tools, s, ctx) => {
    signal = s;
    return next(r, tools, s, ctx);
  };
  await c.service.create(principal, "model-lifecycle", {}, "generation");
  const running = worker(c, fake.engine).tick();
  await fake.ready;
  const r = await row(c);
  await c.db.pool.query("SELECT pg_notify('cloud_agent_cancel',$1)", [
    r.lease_token,
  ]);
  await delay(30);
  assert.equal(signal?.aborted, false);
  fake.finish();
  await running;
});
test("模型能力显式验证，共享资源策略冲突在启动时拒绝", () => {
  const engine: ModelEngine = {
    id: "one",
    capabilities: {
      reasoning: ["low"],
      structuredOutput: "validated",
      maxOutputTokens: 32,
    },
    next: async () => output,
  };
  assert.throws(() => prepareModelRequest(request, engine, []), {
    code: "MODEL_REASONING_UNSUPPORTED",
  });
  assert.throws(
    () =>
      prepareModelRequest(
        { ...request, reasoning: "low", firstOutputTimeoutMs: 10 },
        engine,
        [],
      ),
    { code: "MODEL_PROGRESS_UNSUPPORTED" },
  );
  assert.equal(
    prepareModelRequest({ ...request, reasoning: "low" }, engine, []).reasoning,
    "low",
  );
  assert.throws(
    () =>
      new ModelProfiles(
        { ...engine, lifecycle: { resourceId: "shared", concurrency: 1 } },
        [
          {
            id: "other",
            fingerprint: "one",
            engine: {
              ...engine,
              id: "two",
              lifecycle: { resourceId: "shared", concurrency: 2 },
            },
          },
        ],
      ),
    /MODEL_RESOURCE_POLICY_CONFLICT/,
  );
});

test("适配器部分用量保留预留，迟到完整用量原子结算且取消任务不复活", async (t) => {
  const { WorkspaceCosts } = await import("../packages/observability/costs.js");
  const c = await setup();
  t.after(() => c.close());
  c.registry.register({
    ...moduleFor({ firstOutputTimeoutMs: 50 }),
    budget: { maxCostUsd: 1 },
  });
  const costs = new WorkspaceCosts(c.db, { workspaces: { "workspace-a": 10 } });
  let report:
    | NonNullable<
        import("../packages/contracts/model-lifecycle.js").ModelCallContext["report"]
      >
    | undefined;
  const engine: ModelEngine = {
    id: "demo:echo-v1",
    capabilities: {
      progress: true,
      structuredOutput: "validated",
      maxOutputTokens: 32,
    },
    next: async (_r, _t, _s, ctx) => {
      report = ctx!.report;
      await report!({
        state: "running",
        usage: { costUsd: 0.2, complete: false, estimated: true },
      });
      assert.equal((await row(c)).state, "running");
      return new Promise(() => {});
    },
  };
  const w = new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    engine,
    undefined,
    undefined,
    undefined,
    costs,
  );
  const task = await c.service.create(
    principal,
    "model-lifecycle",
    {},
    "partial",
  );
  await w.tick();
  assert.equal((await row(c)).cost_usd, 0.2);
  assert.equal((await costs.pending("workspace-a"))[0].charged, null);
  await c.service.cancel(principal, task.id);
  await report!({
    state: "completed",
    usage: { costUsd: 0.3, complete: true, estimated: false },
  });
  assert.equal((await row(c)).state, "completed");
  assert.equal(
    (await c.db.pool.query("SELECT charged,category FROM cost_reservations"))
      .rows[0].charged,
    0.3,
  );
  assert.equal((await costs.pending("workspace-a")).length, 0);
  assert.equal((await c.tasks.get(principal, task.id)).status, "cancelled");
  assert.equal((await c.execution.steps(task.id))[0]!.output, null);
});
