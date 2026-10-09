/** 在真实 Worker 与隔离数据库之间注入崩溃窗口，验证模型恢复和预算不会重复执行。 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Worker } from "../packages/runtime/worker.js";
import { sourceDigest } from "../packages/contracts/source.js";
import {
  Problem,
  type Module,
  type ModelEngine,
} from "../packages/contracts/index.js";
import { setup, principal, expired } from "./helpers.js";

function fixture(budget: Module["budget"] = {}): Module {
  return {
    id: "model-recovery",
    version: "1",
    title: "Recovery",
    description: "Recovery",
    capability: "report:run",
    runtime: { model: true },
    input: z.object({}),
    example: {},
    tools: [],
    budget,
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : {
            kind: "model",
            key: "extract",
            request: {
              instructions: "extract",
              messages: [{ role: "user", text: "source" }],
              tools: [],
              timeoutMs: 1000,
              checkpoint: {
                key: "extract-v1",
                sourceDigest: sourceDigest("source"),
              },
            },
          };
    },
  };
}
const turn = {
  text: "checked",
  calls: [],
  costUsd: 0.125,
  costEstimated: false,
  inputTokens: 1,
  outputTokens: 1,
};

for (const mismatch of [false, true]) {
  test(`Worker 崩溃后${mismatch ? "拒绝失配检查点并保留旧费用" : "自动复用检查点且只记账一次"}`, async (t) => {
    const c = await setup();
    t.after(() => c.close());
    c.registry.register(
      fixture({
        maxModelCalls: mismatch ? 2 : 1,
        maxAttempts: mismatch ? 2 : 1,
      }),
    );
    let calls = 0;
    const engine: ModelEngine = {
      id: "demo:echo-v1",
      next: async () => {
        calls++;
        return turn;
      },
    };
    const makeWorker = () =>
      new Worker(c.execution, c.waits, c.identity, c.registry, engine);
    const original = c.execution.checkpointModel.bind(c.execution);
    let oldTask: Parameters<typeof original>[0] | undefined;
    c.execution.checkpointModel = async (...args) => {
      await original(...args);
      oldTask = args[0];
      await expired(c, args[0]);
    };
    const task = await c.service.create(
      principal,
      "model-recovery",
      {},
      "crash",
    );
    await makeWorker().tick();
    assert.equal(calls, 1);
    const step = (await c.execution.steps(task.id))[0]!;
    assert.equal(step.status, "checkpointed");
    assert.equal(Number((await c.tasks.get(principal, task.id)).cost_usd), 0);
    c.execution.checkpointModel = original;
    if (mismatch)
      await c.db.pool.query(
        "UPDATE steps SET checkpoint_hash='outdated' WHERE id=$1",
        [step.id],
      );
    const restarted = makeWorker();
    await restarted.tick();
    assert.equal(calls, mismatch ? 2 : 1);
    const completedStep = (await c.execution.steps(task.id))[0]!;
    assert.equal(completedStep.status, "succeeded");
    assert.ok(oldTask);
    await assert.rejects(
      c.execution.checkpointModel(oldTask, step, turn, "late", 1, 1),
      (error) => error instanceof Problem && error.code === "LEASE_LOST",
    );
    await restarted.tick();
    assert.equal(await restarted.tick(), false);
    const result = await c.tasks.get(principal, task.id);
    assert.equal(result.status, "succeeded");
    assert.equal(Number(result.cost_usd), mismatch ? 0.25 : 0.125);
    assert.equal(result.model_calls, mismatch ? 2 : 1);
    const attempts = await c.db.pool.query(
      "SELECT status FROM invocation_attempts WHERE step_id=$1",
      [step.id],
    );
    assert.equal(
      attempts.rows.filter((r) => r.status === "succeeded").length,
      1,
    );
  });
}

test("任务剩余预算截断模型调用，执行超时冷却且迟到结果不得提交", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(fixture({ maxDurationMs: 1000 }));
  let resolve: (value: typeof turn) => void = () => {};
  let calls = 0;
  const engine: ModelEngine = {
    id: "demo:echo-v1",
    next: async () => {
      calls++;
      return new Promise<typeof turn>((done) => {
        resolve = done;
      });
    },
  };
  const worker = new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    engine,
  );
  const task = await c.service.create(
    principal,
    "model-recovery",
    {},
    "timeout",
  );
  await c.db.pool.query("UPDATE tasks SET execution_ms=975 WHERE id=$1", [
    task.id,
  ]);
  await worker.tick();
  const row = (
    await c.db.pool.query(
      "SELECT status,extract(epoch from available_at-now()) AS seconds FROM tasks WHERE id=$1",
      [task.id],
    )
  ).rows[0];
  assert.equal(row.status, "retry_scheduled");
  assert.ok(Number(row.seconds) > 4);
  resolve(turn);
  await new Promise((done) => setImmediate(done));
  assert.equal(await worker.tick(), false);
  assert.equal(calls, 1);
  assert.equal((await c.execution.steps(task.id))[0]!.output, null);
  const events = await c.db.pool.query(
    "SELECT data FROM events WHERE task_id=$1 AND type='model.retryable'",
    [task.id],
  );
  assert.equal(events.rows[0]?.data.code, "MODEL_EXECUTION_TIMEOUT");
});

test("失配检查点的历史费用耗尽预算后不得再次调用模型", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  c.registry.register(fixture({ maxCostUsd: 0.125 }));
  let calls = 0;
  const engine: ModelEngine = {
    id: "demo:echo-v1",
    next: async () => {
      calls++;
      return turn;
    },
  };
  const worker = new Worker(
    c.execution,
    c.waits,
    c.identity,
    c.registry,
    engine,
  );
  const original = c.execution.checkpointModel.bind(c.execution);
  c.execution.checkpointModel = async (...args) => {
    await original(...args);
    await expired(c, args[0]);
  };
  const task = await c.service.create(
    principal,
    "model-recovery",
    {},
    "budget",
  );
  await worker.tick();
  await c.db.pool.query(
    "UPDATE steps SET checkpoint_hash='outdated' WHERE task_id=$1",
    [task.id],
  );
  c.execution.checkpointModel = original;
  await worker.tick();
  const result = await c.tasks.get(principal, task.id);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "EXECUTION_BUDGET_EXCEEDED");
  assert.equal(Number(result.cost_usd), 0.125);
  assert.equal(calls, 1);
});
