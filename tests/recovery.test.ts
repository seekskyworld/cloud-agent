import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  ExecutionFailure,
  failureOutcome,
  retryAfter,
  retryDelay,
} from "../packages/contracts/failure.js";
import { Problem, type Module } from "../packages/contracts/index.js";
import { DomainHttp } from "../adapters/http/client.js";
import { createApp } from "../apps/api/app.js";
import { CloudAgentClient } from "../packages/api/client.js";
import { setup, principal, drain, token, otherToken } from "./helpers.js";
function failureModule(
  effect: "read" | "unsafe_write",
  execute: () => Promise<never>,
): Module {
  return {
    id: "failure",
    version: "1",
    title: "Failure fixture",
    description: "fixture",
    capability: "report:run",
    runtime: { model: false },
    input: z.object({}),
    example: {},
    tools: [
      {
        name: "failure.run",
        version: "1",
        description: "fixture",
        capability: "report:run",
        input: z.object({}),
        output: z.object({ done: z.boolean() }).strict(),
        effect,
        timeoutMs: 5000,
        execute,
      },
    ],
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : { kind: "tool", key: "write", name: "failure.run", input: {} };
    },
  };
}
test("永久/授权错误终止、429 保留供应商等待窗口，普通写入异常保持 unknown", async () => {
  assert.equal(
    failureOutcome(new Problem(403, "FORBIDDEN"), "read", "x", "FALLBACK").kind,
    "failed",
  );
  assert.equal(
    failureOutcome(new Problem(403, "FORBIDDEN"), "write", "x", "FALLBACK")
      .kind,
    "unknown",
  );
  assert.equal(
    failureOutcome(
      new ExecutionFailure("rate_limited", "RATE_LIMIT", { notAccepted: true }),
      "write",
      "x",
      "FALLBACK",
    ).kind,
    "retryable",
  );
  assert.equal(
    failureOutcome(
      new ExecutionFailure("unknown", "UNCERTAIN"),
      "read",
      "x",
      "FALLBACK",
    ).kind,
    "unknown",
  );
  assert.equal(
    new ExecutionFailure("permanent", "secret text").code,
    "EXECUTION_FAILED",
  );
  assert.equal(retryAfter("120"), 120000);
  assert.equal(retryAfter("invalid"), undefined);
  assert.equal(retryAfter(new Date(200000).toUTCString(), 100000), 100000);
  assert.throws(() => retryDelay(Infinity, 0), /RETRY_DELAY_INVALID/);
  const c = await setup();
  let mode = 0;
  c.registry.register(
    failureModule("read", async () => {
      if (mode === 0)
        throw new ExecutionFailure("rate_limited", "LIMITED", {
          retryAfterMs: 120000,
        });
      throw new Problem(403, "ACCESS_DENIED");
    }),
  );
  try {
    const task = await c.tasks.create(principal, "failure", {}, "delayed");
    await c.worker.tick();
    const row = (
      await c.db.pool.query(
        "SELECT status,available_at-now() AS delay,extract(epoch from available_at-now()) AS seconds FROM tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0];
    assert.equal(row.status, "retry_scheduled");
    assert.ok(Number(row.seconds) > 110);
    mode = 1;
    await c.db.pool.query("UPDATE tasks SET available_at=now() WHERE id=$1", [
      task.id,
    ]);
    await drain(c);
    assert.equal(
      (await c.tasks.get(principal, task.id)).error,
      "ACCESS_DENIED",
    );
  } finally {
    await c.close();
  }
});
test("未知写入人工核实：受控恢复、版本/输出验证、并发幂等、跨工作区与撤权拒绝", async () => {
  const c = await setup();
  let writes = 0;
  c.registry.register(
    failureModule("unsafe_write", async () => {
      writes++;
      throw new Error("remote accepted then disconnected");
    }),
  );
  const app = await createApp(c);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new CloudAgentClient({
    baseUrl: app.listeningOrigin,
    token: () => token,
  });
  try {
    const task = await client.call(
      "create",
      { moduleId: "failure", input: {} },
      { key: "unknown" },
    );
    await drain(c);
    await assert.rejects(
      client.call("retry", {}, { id: task.id }),
      /MANUAL_RECONCILIATION_REQUIRED/,
    );
    const detail = await client.call("detail", undefined, { id: task.id }),
      step = detail.steps[0]!;
    const input = {
      stepId: step.id,
      expectedAttempts: step.attempts,
      decision: "succeeded" as const,
      output: { done: true },
      reason: "核对外部账单",
      receipt: "external-42",
    };
    await assert.rejects(
      client.call(
        "reconcile",
        { ...input, expectedAttempts: 2 },
        { id: task.id, key: "stale" },
      ),
      /STEP_NOT_RECONCILABLE/,
    );
    await assert.rejects(
      client.call(
        "reconcile",
        { ...input, output: { wrong: true } },
        { id: task.id, key: "bad" },
      ),
    );
    const other = new CloudAgentClient({
      baseUrl: app.listeningOrigin,
      token: () => otherToken,
    });
    await assert.rejects(
      other.call("reconcile", input, { id: task.id, key: "cross" }),
      /TASK_NOT_FOUND/,
    );
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_remove(capabilities,'task:reconcile') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    await assert.rejects(
      client.call("reconcile", input, { id: task.id, key: "revoke" }),
      /FORBIDDEN/,
    );
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_append(capabilities,'task:reconcile') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    await Promise.all([
      client.call("reconcile", input, { id: task.id, key: "resolve" }),
      client.call("reconcile", input, { id: task.id, key: "resolve" }),
    ]);
    await assert.rejects(
      client.call(
        "reconcile",
        { ...input, receipt: "changed" },
        { id: task.id, key: "resolve" },
      ),
      /IDEMPOTENCY_CONFLICT/,
    );
    await drain(c);
    assert.equal(
      (await client.call("detail", undefined, { id: task.id })).task.status,
      "succeeded",
    );
    assert.equal(writes, 1);
    assert.equal(
      (
        await c.db.pool.query(
          "SELECT * FROM task_reconciliations WHERE task_id=$1",
          [task.id],
        )
      ).rowCount,
      1,
    );
    const cancel = await client.call(
      "create",
      { moduleId: "failure", input: {} },
      { key: "cancel-unknown" },
    );
    await drain(c);
    const pending = (await client.call("detail", undefined, { id: cancel.id }))
      .steps[0]!;
    await client.call(
      "reconcile",
      { ...input, stepId: pending.id, decision: "cancelled" },
      { id: cancel.id, key: "stop" },
    );
    await assert.rejects(
      client.call("retry", {}, { id: cancel.id }),
      /NOT_RETRYABLE/,
    );
  } finally {
    await app.close();
    await c.close();
  }
});
test("HTTP 非 JSON 限流响应仍分类并保留 Retry-After，不泄露远端正文", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429, { "retry-after": "120" });
    res.end("secret upstream HTML");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new DomainHttp(
      "fixture",
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      {
        [principal.workspace_id]: {
          [principal.id]: { fixture: "fixture-token" },
        },
      },
    );
    await assert.rejects(
      client.json("/rate", {
        principal,
        taskId: "x",
        runId: "x",
        invocationId: "x",
        idempotencyKey: "x",
        signal: AbortSignal.timeout(2000),
      }),
      (error: unknown) =>
        error instanceof ExecutionFailure &&
        error.category === "rate_limited" &&
        error.options.retryAfterMs === 120000 &&
        !error.message.includes("secret"),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("真实 Pi HTTP 401 不重试、429 传递 Retry-After，错误正文不进入协议", async () => {
  const { PiEngine } = await import("../adapters/engine-pi/index.js");
  let status = 401;
  const server = createServer((_req, res) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "retry-after": "90",
    });
    res.end(
      JSON.stringify({
        error: { message: "secret-upstream-details", type: "test" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const engine = new PiEngine({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: "fixture",
      model: "test",
      inputPrice: 1,
      outputPrice: 1,
    });
    await assert.rejects(
      engine.next(
        {
          instructions: "x",
          messages: [{ role: "user", text: "x" }],
          tools: [],
        },
        [],
        AbortSignal.timeout(3000),
      ),
      (e: unknown) =>
        e instanceof ExecutionFailure &&
        e.category === "authorization" &&
        !e.message.includes("secret"),
    );
    status = 429;
    await assert.rejects(
      engine.next(
        {
          instructions: "x",
          messages: [{ role: "user", text: "x" }],
          tools: [],
        },
        [],
        AbortSignal.timeout(3000),
      ),
      (e: unknown) =>
        e instanceof ExecutionFailure &&
        e.category === "rate_limited" &&
        e.options.retryAfterMs === 90000,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
