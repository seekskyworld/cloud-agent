/** 实际 Responses SSE 协议：总输出含推理用量，不能用可见文字长度替代。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import { PiEngine } from "../adapters/engine-pi/index.js";
import { ModelOptions } from "../apps/models.js";
import { prepareModelRequest } from "../packages/runtime/model-request.js";
const answer = '{"kind":"answer","text":"请补充礼物编号，确认后才会执行。"}';
function responseStream(tokens: number, status = "completed") {
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: answer,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: `response.${status}`,
      response: {
        id: "resp_fixture",
        status,
        output: [item],
        incomplete_details:
          status === "incomplete" ? { reason: "max_output_tokens" } : null,
        usage: {
          input_tokens: 2565,
          output_tokens: tokens,
          output_tokens_details: { reasoning_tokens: tokens - 251 },
          total_tokens: 2565 + tokens,
        },
      },
    },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
for (const scenario of [
  {
    name: "complete answer with reasoning overhead",
    limit: 8192,
    tokens: 2935,
    status: "completed",
    passes: true,
  },
  {
    name: "legacy explicit small request",
    limit: 2048,
    tokens: 2935,
    status: "completed",
    passes: false,
  },
  {
    name: "provider exceeds the enlarged budget",
    limit: 8192,
    tokens: 8193,
    status: "completed",
    passes: false,
  },
  {
    name: "valid-looking JSON with provider truncation",
    limit: 8192,
    tokens: 8192,
    status: "incomplete",
    passes: false,
  },
  {
    name: "unchanged default request limit",
    limit: undefined,
    tokens: 2935,
    status: "completed",
    passes: false,
  },
]) {
  test(`Responses output budget: ${scenario.name}`, async (t) => {
    const api = Fastify({ forceCloseConnections: true });
    t.after(() => api.close());
    let calls = 0;
    api.post("/responses", async (req, reply) => {
      calls++;
      const body = req.body as {
        max_output_tokens: number;
        tools: unknown[];
        input: { role: string; content: unknown }[];
      };
      assert.equal(body.max_output_tokens, scenario.limit ?? 2048);
      assert.deepEqual(body.tools, []);
      assert.equal(body.input[0]?.role, "system");
      assert.deepEqual(body.input[0]?.content, "Return JSON");
      return reply
        .type("text/event-stream")
        .send(responseStream(scenario.tokens, scenario.status));
    });
    const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
    const engine = new PiEngine({
      protocol: "responses",
      baseUrl,
      apiKey: "fixture",
      model: "fixture",
      inputPrice: 1,
      outputPrice: 4,
    });
    const request = prepareModelRequest(
      {
        instructions: "Return JSON",
        messages: [{ role: "user", text: "help" }],
        tools: [],
        maxOutputTokens: scenario.limit,
      },
      engine,
      [],
    );
    const result = engine.next(request, [], AbortSignal.timeout(5000));
    if (scenario.passes) {
      const turn = await result;
      assert.equal(turn.text, answer);
      assert.equal(turn.outputTokens, scenario.tokens);
      assert.ok(
        Math.abs(turn.costUsd - (2565 + scenario.tokens * 4) / 1_000_000) <
          1e-12,
      );
    } else await assert.rejects(result, { code: "MODEL_OUTPUT_LIMIT" });
    assert.equal(
      calls,
      1,
      "output rejection must not cause an implicit second call",
    );
  });
}
test("configured model ceiling is validated and participates in the engine fingerprint", () => {
  for (const value of [0, 15, 8192.5, 131073])
    assert.equal(
      ModelOptions.safeParse({ maxOutputTokens: value }).success,
      false,
    );
  const config = {
    baseUrl: "https://example.invalid",
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 4,
  };
  const standard = new PiEngine(config);
  // 防止仅更新依赖后仍把旧 SDK 的检查点视为兼容结果。
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.ok(
    standard.id.startsWith(
      `pi:${manifest.dependencies["@earendil-works/pi-ai"]}:`,
    ),
  );
  const custom = new PiEngine({
    ...config,
    ...ModelOptions.parse({ maxOutputTokens: 16384 }),
  });
  assert.equal(standard.capabilities.maxOutputTokens, 8192);
  assert.equal(custom.capabilities.maxOutputTokens, 16384);
  assert.notEqual(standard.id, custom.id);
  const request = {
    instructions: "test",
    messages: [],
    tools: [],
    maxOutputTokens: 16384,
  };
  assert.doesNotThrow(() => prepareModelRequest(request, custom, []));
  assert.throws(
    () => prepareModelRequest(request, standard, []),
    /MODEL_OUTPUT_LIMIT_UNSUPPORTED/,
  );
});

test("unknown gateway context capacity does not silently clamp multi-image output to one token", async (t) => {
  const api = Fastify({ forceCloseConnections: true });
  t.after(() => api.close());
  let requestedTokens = 0;
  api.post("/responses", async (req, reply) => {
    requestedTokens = (req.body as { max_output_tokens: number })
      .max_output_tokens;
    return reply.type("text/event-stream").send(responseStream(300));
  });
  const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const engine = new PiEngine({
    protocol: "responses",
    baseUrl,
    apiKey: "fixture",
    model: "gateway",
    inputPrice: 1,
    outputPrice: 4,
  });
  await engine.next(
    {
      instructions: "Review images",
      messages: [
        {
          role: "user",
          text: "Visual evidence",
          content: Array.from({ length: 30 }, () => ({
            type: "image" as const,
            mediaType: "image/png",
            data: "aGVsbG8=",
          })),
        },
      ],
      tools: [],
      maxOutputTokens: 8192,
    },
    [],
    AbortSignal.timeout(5000),
  );
  assert.equal(requestedTokens, 8192);
  assert.notEqual(
    engine.id,
    new PiEngine({
      protocol: "responses",
      baseUrl,
      apiKey: "fixture",
      model: "gateway",
      inputPrice: 1,
      outputPrice: 4,
      contextWindow: 200000,
    }).id,
  );
  for (const contextWindow of [0, 4095, 2000001, 10000.5])
    assert.equal(ModelOptions.safeParse({ contextWindow }).success, false);
});

test("Responses tool call with malformed final arguments is never executed with empty arguments", async (t) => {
  const api = Fastify({ forceCloseConnections: true });
  t.after(() => api.close());
  const item = {
    id: "fc_fixture",
    type: "function_call",
    status: "completed",
    call_id: "call_fixture",
    // 引擎把工具名编码成 t_<hex> 发给供应商。
    name: `t_${Buffer.from("lookup").toString("hex")}`,
    arguments: '{"giftId": "a1",',
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  api.post("/responses", async (_req, reply) =>
    reply
      .type("text/event-stream")
      .send(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
      ),
  );
  const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const engine = new PiEngine({
    protocol: "responses",
    baseUrl,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 4,
  });
  const tool = {
    name: "lookup",
    version: "1.0.0",
    description: "Look up a gift",
    input: z.object({ giftId: z.string().optional() }),
    output: z.object({}),
    capability: "fixture",
    effect: "read" as const,
    timeoutMs: 1000,
    execute: async () => ({ kind: "succeeded" as const, output: {} }),
  };
  const request = prepareModelRequest(
    {
      instructions: "Use tools",
      messages: [{ role: "user", text: "find a1" }],
      tools: ["lookup"],
    },
    engine,
    [tool],
  );
  // 下游引擎把它作为未执行的可纠正回合交给模型，不执行空参数。
  const turn = await engine.next(request, [tool], AbortSignal.timeout(5000));
  assert.deepEqual(turn.calls, []);
  assert.equal(
    (turn.data as { reason?: string } | undefined)?.reason,
    "tool_arguments_invalid",
  );
  assert.match(turn.text, /giftId/);
});
