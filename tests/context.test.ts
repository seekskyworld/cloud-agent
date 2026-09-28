import { ExecutionFailure } from "../packages/contracts/failure.js";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createContainer } from "../apps/container.js";
import {
  Problem,
  type ModelEngine,
  type ModelTurn,
  type Module,
} from "../packages/contracts/index.js";
import type { ContextProvider } from "../packages/context/index.js";
import { ContextManager } from "../packages/context/index.js";
import {
  modelCheckpointHash,
  prepareModelRequest,
  validateModelTurn,
} from "../packages/runtime/model-request.js";
import {
  restoreSourceRanges,
  sourceDigest,
} from "../packages/contracts/source.js";
import { Registry } from "../packages/runtime/registry.js";
import { setup, principal, drain } from "./helpers.js";
const output: ModelTurn = {
  text: '{"answer":"ok"}',
  calls: [],
  costUsd: 0,
  costEstimated: false,
  inputTokens: 10,
  outputTokens: 10,
};
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
test("模型请求显式关闭推理和缓存，并按原文摘要恢复范围", () => {
  const engine: ModelEngine = {
    id: "fixture",
    capabilities: {
      structuredOutput: "validated",
      maxOutputTokens: 1000,
      reasoning: ["none"],
      cache: true,
    },
    next: async () => output,
  };
  const request = {
    instructions: "extract",
    messages: [{ role: "user" as const, text: "a" }],
    tools: ["unused", "unused"],
    checkpoint: { key: "extract-v1", sourceDigest: sourceDigest("a\nb") },
  };
  const prepared = prepareModelRequest(request, engine, []);
  assert.equal(prepared.reasoning, "none");
  assert.equal(prepared.cache, "disabled");
  assert.deepEqual(prepared.tools, ["unused"]);
  assert.ok(modelCheckpointHash("module-v1", engine.id, request));
  assert.equal(
    restoreSourceRanges("a\nb", request.checkpoint.sourceDigest, [
      { startLine: 2, endLine: 2 },
    ]),
    "b",
  );
  assert.throws(
    () =>
      restoreSourceRanges("a\nc", request.checkpoint.sourceDigest, [
        { startLine: 1, endLine: 1 },
      ]),
    /SOURCE_DIGEST_MISMATCH/,
  );
});
function module(): Module {
  return {
    id: "context-fixture",
    version: "1",
    title: "Context fixture",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: true, contexts: ["docs"] },
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : {
            kind: "model",
            key: "answer",
            request: {
              instructions: "Answer",
              messages: [],
              tools: [],
              contexts: [{ provider: "docs", query: { topic: "demo" } }],
              outputSchema: schema,
              inputTokenBudget: 10000,
              maxOutputTokens: 200,
            },
          };
    },
  };
}
test("上下文快照重放不重新检索，模型前和结果读取复核当前 ACL；指纹隔离", async () => {
  const base = await setup();
  let loads = 0,
    calls = 0,
    allowed = true;
  const provider: ContextProvider = {
    id: "docs",
    version: "1",
    identity: "fixture-v1",
    capability: "report:run",
    load: async () => {
      loads++;
      return [{ id: "doc-1", text: "reference-v1" }];
    },
    authorize: async (_docs, p) => {
      assert.equal(p.workspace_id, principal.workspace_id);
      if (!allowed) throw new Problem(403, "DOCUMENT_REVOKED");
    },
  };
  const engine: ModelEngine = {
    id: "fixture",
    capabilities: { structuredOutput: "validated", maxOutputTokens: 1000 },
    async next(request) {
      calls++;
      assert.match(request.messages.at(-1)!.text, /reference-v1/);
      if (calls === 1)
        throw new ExecutionFailure("transient", "MODEL_NOT_ACCEPTED", {
          notAccepted: true,
        });
      return output;
    },
  };
  const c = await createContainer(base.config, {
    modules: [module()],
    engine,
    contexts: [provider],
  });
  try {
    const task = await c.service.create(
      principal,
      "context-fixture",
      {},
      "context",
    );
    await c.worker.tick();
    assert.equal(
      (await c.tasks.get(principal, task.id)).status,
      "retry_scheduled",
    );
    await c.db.pool.query("UPDATE tasks SET available_at=now() WHERE id=$1", [
      task.id,
    ]);
    await drain(c);
    assert.equal(loads, 1);
    assert.equal(calls, 2);
    const detail = await c.service.detail(principal, task.id);
    assert.equal(detail.task.status, "succeeded");
    assert.deepEqual((detail.task.result as Record<string, unknown>).data, {
      answer: "ok",
    });
    allowed = false;
    await assert.rejects(
      c.service.detail(principal, task.id),
      /DOCUMENT_REVOKED/,
    );
    await assert.rejects(
      c.service.artifact(principal, detail.artifacts[0].id),
      /DOCUMENT_REVOKED/,
    );
    await assert.rejects(
      c.service.detail({ ...principal, workspace_id: "workspace-b" }, task.id),
      /TASK_NOT_FOUND/,
    );
    allowed = true;
    const changed = await createContainer(base.config, {
      modules: [module()],
      engine,
      contexts: [{ ...provider, identity: "fixture-v2" }],
    });
    try {
      assert.equal(changed.registry.accepts(task), false);
      await assert.rejects(
        changed.service.detail(principal, task.id),
        /CONTEXT_PROVIDER_CHANGED/,
      );
    } finally {
      await changed.close();
    }
    const before = new Registry("same"),
      after = new Registry("same", {}, c.contexts.fingerprints());
    const plain = { ...module(), runtime: { model: false } };
    assert.equal(before.hash(plain), after.hash(plain));
  } finally {
    await c.close();
    await base.close();
  }
});
test("上下文撤权阻止模型；未声明依赖和超预算不进入模型", async () => {
  const base = await setup();
  let calls = 0,
    checks = 0;
  const engine: ModelEngine = {
    id: "fixture",
    capabilities: { structuredOutput: "validated", maxOutputTokens: 1000 },
    async next() {
      calls++;
      return output;
    },
  };
  const provider: ContextProvider = {
    id: "docs",
    version: "1",
    identity: "test",
    capability: "report:run",
    load: async () => [{ id: "d", text: "data" }],
    authorize: async () => {
      checks++;
      if (checks > 1) throw new Problem(403, "DOCUMENT_REVOKED");
    },
  };
  const c = await createContainer(base.config, {
    modules: [module()],
    engine,
    contexts: [provider],
  });
  try {
    const task = await c.service.create(
      principal,
      "context-fixture",
      {},
      "revoked",
    );
    await drain(c);
    assert.equal(
      (await c.tasks.get(principal, task.id)).error,
      "DOCUMENT_REVOKED",
    );
    assert.equal(calls, 0);
    assert.throws(
      () => new ContextManager(c.db, [provider, provider]),
      /DUPLICATE/,
    );
    const absent = new Registry();
    assert.throws(
      () => absent.register(module()),
      /CONTEXT_PROVIDER_UNAVAILABLE/,
    );
    const claimed = await c.tasks.create(
      principal,
      "context-fixture",
      {},
      "budget",
    );
    await assert.rejects(
      c.contexts.load(
        claimed,
        "unused",
        Array(5).fill({ provider: "docs", query: {} }),
        ["docs"],
        principal,
        AbortSignal.timeout(1000),
      ),
      /BUDGET_EXCEEDED/,
    );
    await assert.rejects(
      c.contexts.load(
        claimed,
        "unused",
        [{ provider: "docs", query: {} }],
        [],
        principal,
        AbortSignal.timeout(1000),
      ),
      /UNDECLARED/,
    );
    await assert.rejects(
      c.contexts.load(
        claimed,
        "unused",
        [{ provider: "docs", query: {} }],
        ["docs"],
        { ...principal, workspace_id: "other" },
        AbortSignal.timeout(1000),
      ),
      /TASK_NOT_FOUND/,
    );
  } finally {
    await c.close();
    await base.close();
  }
});
test("结构化输出显式声明能力、平台校验 JSON 和预算，工具提议不强制终态 JSON", () => {
  const engine: ModelEngine = {
    id: "test",
    capabilities: { structuredOutput: "validated", maxOutputTokens: 1000 },
    next: async () => output,
  };
  const request = {
    instructions: "test",
    messages: [],
    tools: [],
    outputSchema: schema,
  };
  assert.deepEqual(validateModelTurn(request, output).data, { answer: "ok" });
  assert.throws(
    () => validateModelTurn(request, { ...output, text: '{"answer":1}' }),
    /Execution failed/,
  );
  assert.throws(
    () => validateModelTurn(request, { ...output, text: "```json\n{}" }),
    /Execution failed/,
  );
  assert.equal(
    validateModelTurn(request, {
      ...output,
      calls: [{ id: "x", name: "x", arguments: {} }],
    }).data,
    undefined,
  );
  assert.throws(
    () =>
      prepareModelRequest(request, { ...engine, capabilities: undefined }, []),
    /STRUCTURED_OUTPUT_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      prepareModelRequest({ ...request, maxOutputTokens: 2000 }, engine, []),
    /OUTPUT_LIMIT_UNSUPPORTED/,
  );
  assert.throws(
    () => prepareModelRequest({ ...request, inputTokenBudget: 10 }, engine, []),
    /BUDGET_EXCEEDED/,
  );
  assert.throws(
    () => prepareModelRequest({ ...request, inputTokenBudget: -1 }, engine, []),
    /BUDGET_INVALID/,
  );
  assert.throws(
    () => prepareModelRequest({ ...request, timeoutMs: 999 }, engine, []),
    /TIMEOUT_INVALID/,
  );
  assert.throws(
    () =>
      prepareModelRequest(
        { ...request, reasoning: "low" },
        {
          ...engine,
          capabilities: { ...engine.capabilities!, reasoning: ["none"] },
        },
        [],
      ),
    /REASONING_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      prepareModelRequest(
        { ...request, outputSchema: { type: "bad" } },
        engine,
        [],
      ),
    /SCHEMA_INVALID/,
  );
  assert.match(
    prepareModelRequest(request, engine, []).instructions,
    /Return only JSON/,
  );
});

test("结构化输出失败仍计费且不自动重试；Pi 实际请求接受输出预算", async () => {
  const { createServer } = await import("node:http");
  const { PiEngine } = await import("../adapters/engine-pi/index.js");
  let observed: Record<string, unknown> = {},
    answer = '{"answer":"ok"}';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    observed = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "text/event-stream");
    const part = {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: answer },
          finish_reason: null,
        },
      ],
    };
    res.end(
      `data: ${JSON.stringify(part)}\n\ndata: ${JSON.stringify({ ...part, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = await setup();
  const engine = new PiEngine({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
  });
  const fixture = module(),
    next = fixture.next;
  fixture.runtime = { model: true };
  fixture.next = (input, steps) => {
    const action = next(input, steps);
    if (action.kind === "model") delete action.request.contexts;
    return action;
  };
  const c = await createContainer(base.config, { modules: [fixture], engine });
  try {
    const first = await c.service.create(
      principal,
      fixture.id,
      {},
      "pi-structured",
    );
    await drain(c);
    assert.equal((await c.tasks.get(principal, first.id)).status, "succeeded");
    assert.equal(observed.max_tokens ?? observed.max_completion_tokens, 200);
    assert.match(JSON.stringify(observed.messages), /Return only JSON/);
    assert.deepEqual(observed.tools, []);
    assert.equal(observed.reasoning_effort, "none");
    assert.equal("prompt_cache_key" in observed, false);
    assert.equal("prompt_cache_retention" in observed, false);
    const reasoningEngine = new PiEngine({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture",
      model: "fixture",
      inputPrice: 1,
      outputPrice: 1,
      reasoning: true,
    });
    await reasoningEngine.next(
      {
        instructions: "reasoning",
        messages: [],
        tools: [],
        reasoning: "low",
        cache: "disabled",
        timeoutMs: 5_000,
      },
      [],
      new AbortController().signal,
    );
    assert.equal(observed.reasoning_effort, "low");
    assert.deepEqual(observed.tools, []);
    answer = '{"invalid":true}';
    const bad = await c.service.create(principal, fixture.id, {}, "pi-bad");
    await drain(c);
    const result = await c.tasks.get(principal, bad.id);
    assert.equal(result.error, "MODEL_OUTPUT_INVALID");
    assert.equal(result.model_calls, 1);
    assert.ok(Number(result.cost_usd) > 0);
  } finally {
    await c.close();
    await base.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
test("取消使在途上下文失去快照提交权；供应器异常和文档大小有明确边界", async () => {
  const base = await setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ContextProvider = {
    id: "docs",
    version: "1",
    identity: "cancel",
    capability: "report:run",
    load: async () => {
      await gate;
      return [{ id: "d", text: "data" }];
    },
    authorize: async () => {},
  };
  const c = await createContainer(base.config, {
    modules: [module()],
    contexts: [provider],
  });
  try {
    const task = await c.service.create(
      principal,
      "context-fixture",
      {},
      "cancel-context",
    );
    const claimed = (await c.execution.claim("test"))!;
    const action = module().next({}, []);
    assert.equal(action.kind, "model");
    if (action.kind !== "model") throw new Error("invalid");
    const step = await c.execution.prepare(claimed, action);
    const loading = c.contexts.load(
      claimed,
      step.id,
      [{ provider: "docs", query: {} }],
      ["docs"],
      principal,
      AbortSignal.timeout(2000),
    );
    await c.service.cancel(principal, task.id);
    release();
    await assert.rejects(loading, /LEASE_LOST/);
    assert.equal(
      (
        await c.db.pool.query(
          "SELECT * FROM context_snapshots WHERE task_id=$1",
          [task.id],
        )
      ).rowCount,
      0,
    );
    const huge = new ContextManager(c.db, [
      { ...provider, load: async () => [{ id: "d", text: "x".repeat(25000) }] },
    ]);
    await assert.rejects(
      huge.load(
        claimed,
        step.id,
        [{ provider: "docs", query: {} }],
        ["docs"],
        principal,
        AbortSignal.timeout(1000),
      ),
      /CONTEXT_DOCUMENT_INVALID/,
    );
    const hanging = new ContextManager(c.db, [
      { ...provider, load: () => new Promise(() => {}) },
    ]);
    // 保持事件循环有活跃句柄，验证不响应 signal 的实现也被边界中断。
    const timer = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        hanging.load(
          claimed,
          step.id,
          [{ provider: "docs", query: {} }],
          ["docs"],
          principal,
          AbortSignal.timeout(20),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release();
    await c.close();
    await base.close();
  }
});
