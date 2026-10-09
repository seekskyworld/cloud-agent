/** 受控 HTTP 服务验证真实协议与身份映射，不调用外部模型或实际业务。 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { z } from "zod";
import { DomainHttp } from "../adapters/http/client.js";
import { PiEngine } from "../adapters/engine-pi/index.js";
import type { ExecutionContext, Tool } from "../packages/contracts/index.js";
const principal = {
  id: "user",
  workspace_id: "space",
  enabled: true,
  role: "member" as const,
  capabilities: ["example:read", "example:write"],
};
const context: ExecutionContext = {
  principal,
  taskId: "task",
  runId: "run",
  invocationId: "invocation",
  idempotencyKey: "stable-key",
  signal: AbortSignal.timeout(10000),
};
const credentials = {
  space: {
    user: { example: "test-user-credential" },
  },
};

test("通用 HTTP 使用服务名和逐用户凭据，并保留状态码及响应", async (t) => {
  const app = Fastify();
  app.get("/records", async (req, reply) => {
    assert.equal(req.headers.authorization, "Bearer test-user-credential");
    return reply.code(503).send({ retry: true });
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const response = await new DomainHttp("example", base, credentials).request(
    "/records",
    context,
  );
  assert.deepEqual(response, { status: 503, data: { retry: true } });
});
test("HTTP 写入传递稳定动作编号，无对应用户凭据时不回退共享身份", async (t) => {
  const app = Fastify();
  let calls = 0;
  app.post("/commands", async (req) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer test-user-credential");
    assert.equal(req.headers["idempotency-key"], "stable-key");
    return { ok: true };
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const client = new DomainHttp("example", base, credentials);
  assert.equal(
    (await client.request("/commands", context, { value: 1 })).status,
    200,
  );
  await assert.rejects(
    client.request(
      "/commands",
      { ...context, principal: { ...principal, id: "another" } },
      {},
    ),
  );
  assert.equal(calls, 1);
});
test("领域 HTTP 禁止重定向向另一个地址发送凭据", async (t) => {
  const app = Fastify();
  let target = 0;
  app.get("/redirect", async (_req, reply) => reply.redirect("/target"));
  app.get("/target", async () => {
    target++;
    return {};
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  await assert.rejects(
    new DomainHttp("example", base, credentials).request("/redirect", context),
  );
  assert.equal(target, 0);
});
test("Pi 真正完成单轮协议调用并规范化工具请求，不执行工具", async (t) => {
  const app = Fastify();
  let requestedTool = "";
  app.post("/chat/completions", async (req, reply) => {
    const body = req.body as { tools: { function: { name: string } }[] };
    requestedTool = body.tools[0]!.function.name;
    assert.match(requestedTool, /^[A-Za-z0-9_]+$/);
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    reply.type("text/event-stream");
    return `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: requestedTool, arguments: '{"query":"test"}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`;
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    baseUrl: base,
    apiKey: "fixture-key",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 2,
  });
  const tool: Tool = {
    name: "example.search",
    version: "1",
    description: "search",
    input: z.object({ query: z.string() }),
    output: z.object({}),
    capability: "example:read",
    effect: "read",
    timeoutMs: 1000,
    async execute() {
      throw new Error("Must not execute in adapter");
    },
  };
  const result = await engine.next(
    {
      instructions: "test",
      messages: [{ role: "user", text: "test" }],
      tools: [tool.name],
    },
    [tool],
    context.signal,
  );
  assert.equal(result.calls[0]!.name, tool.name);
  assert.deepEqual(result.calls[0]!.arguments, { query: "test" });
  assert.equal(result.outputTokens, 10);
});

test("Pi 超时分类保留退避窗口，SDK 不在 HTTP 失败后自行重试", async (t) => {
  const app = Fastify();
  let status = 504,
    calls = 0;
  app.post("/chat/completions", async (_req, reply) => {
    calls++;
    return reply
      .code(status)
      .header("retry-after", "1")
      .send({ error: { message: "fixture" } });
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    baseUrl: base,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
  });
  const { ExecutionFailure } = await import("../packages/contracts/failure.js");
  for (const code of [504, 408, 425, 429]) {
    status = code;
    const before = calls;
    await assert.rejects(
      engine.next(
        { instructions: "", messages: [], tools: [] },
        [],
        new AbortController().signal,
      ),
      (error) => {
        assert.ok(error instanceof ExecutionFailure);
        assert.equal(
          error.code,
          code === 504
            ? "MODEL_EXECUTION_TIMEOUT"
            : code === 429
              ? "MODEL_HTTP_REJECTED"
              : "MODEL_QUEUE_TIMEOUT",
        );
        assert.equal(error.options.retryAfterMs, code === 504 ? 5000 : 1000);
        return true;
      },
    );
    assert.equal(calls - before, 1);
  }
});
