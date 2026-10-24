import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { z } from "zod";
import { PiEngine } from "../adapters/engine-pi/index.js";
import type { Tool } from "../packages/contracts/index.js";
test("Anthropic max and high reasoning reach adaptive thinking and video frames retain exact timecodes", async (t) => {
  const server = Fastify();
  t.after(() => server.close());
  const bodies: Record<string, unknown>[] = [];
  server.post("/v1/messages", async (req, reply) => {
    bodies.push(req.body as Record<string, unknown>);
    const events = [
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "OK" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    return reply
      .type("text/event-stream")
      .send(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
      );
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const engine = new PiEngine({
    baseUrl,
    apiKey: "test-only",
    model: "global.anthropic.claude-opus-5-5",
    protocol: "anthropic",
    inputPrice: 1,
    outputPrice: 1,
    maxOutputTokens: 16384,
    reasoningLevels: ["none", "high", "max"],
  });
  for (const reasoning of ["high", "none", "max"] as const) {
    await engine.next(
      {
        instructions: "inspect",
        messages: [
          {
            role: "user",
            text: "video",
            contextOmissions: [{ key: "AUDIT_ONLY_OMITTED_BATCH", images: 42 }],
            content: [
              {
                type: "video",
                mediaType: "video/mp4",
                frames: [
                  {
                    data: "ZmFrZQ==",
                    mediaType: "image/jpeg",
                    timestampSeconds: 3.25,
                  },
                  {
                    data: "ZmFrZQ==",
                    mediaType: "image/jpeg",
                    timestampSeconds: 9.5,
                  },
                ],
              },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 12000,
        reasoning,
      },
      [],
      AbortSignal.timeout(5000),
    );
  }
  assert.equal((bodies[0]!.thinking as { type: string }).type, "adaptive");
  assert.equal((bodies[0]!.output_config as { effort: string }).effort, "high");
  assert.equal(bodies[0]!.max_tokens, 12000);
  assert.equal((bodies[1]!.thinking as { type: string }).type, "disabled");
  assert.equal((bodies[2]!.thinking as { type: string }).type, "adaptive");
  assert.equal((bodies[2]!.output_config as { effort: string }).effort, "max");
  assert.equal(bodies[2]!.max_tokens, 12000);
  const text = JSON.stringify(bodies[0]!.messages);
  assert.doesNotMatch(
    JSON.stringify(bodies),
    /AUDIT_ONLY_OMITTED_BATCH|contextOmissions/,
  );
  assert.match(text, /3\.250/);
  assert.match(text, /9\.500/);
});

test("unknown Anthropic tool names discard the entire batch without dispatch; exact advertised aliases remain usable", async (t) => {
  const server = Fastify();
  t.after(() => server.close());
  let names: string[] = [];
  server.post("/v1/messages", async (_req, reply) => {
    const events: { type: string; [key: string]: unknown }[] = [
      {
        type: "message_start",
        message: {
          id: "tool-feedback",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
    ];
    for (const [index, name] of names.entries())
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: `call-${index}`,
            name,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: '{"value":"test"}' },
        },
        { type: "content_block_stop", index },
      );
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 20 },
      },
      { type: "message_stop" },
    );
    return reply
      .type("text/event-stream")
      .send(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
      );
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const engine = new PiEngine({
    baseUrl,
    apiKey: "test-only",
    model: "global.anthropic.claude-opus-5-5",
    protocol: "anthropic",
    inputPrice: 1,
    outputPrice: 1,
  });
  const tool: Tool = {
    name: "demo.allowed",
    version: "1.0.0",
    description: "allowed fixture",
    capability: "test",
    effect: "idempotent_write",
    timeoutMs: 1000,
    input: z.object({ value: z.string() }),
    output: z.object({}),
    async execute() {
      throw Error("ENGINE_MUST_NOT_EXECUTE_TOOLS");
    },
  };
  const request = {
    instructions: "test",
    messages: [{ role: "user" as const, text: "test" }],
    tools: [tool.name],
    maxOutputTokens: 100,
  };
  names = [
    "demo.not-advertised",
    `t_${Buffer.from(tool.name).toString("hex")}`,
  ];
  const rejected = await engine.next(
    request,
    [tool],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(rejected.calls, []);
  assert.deepEqual(
    z
      .object({
        incomplete: z.boolean(),
        reason: z.string(),
        discardedToolCalls: z.boolean(),
        unrecognizedTools: z.array(z.string()),
      })
      .parse(rejected.data),
    {
      incomplete: true,
      reason: "unrecognized_tool",
      discardedToolCalls: true,
      unrecognizedTools: ["demo.not-advertised"],
    },
  );
  assert.equal(rejected.outputTokens, 20);
  assert.ok(rejected.costUsd > 0);
  names = [tool.name, tool.name];
  const oversized = await engine.next(
    { ...request, maxToolCalls: 1 },
    [tool],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(oversized.calls, []);
  assert.equal(
    (oversized.data as { reason: string }).reason,
    "tool_batch_limit",
  );
  assert.equal(oversized.outputTokens, 20);
  names = [tool.name];
  const corrected = await engine.next(
    request,
    [tool],
    AbortSignal.timeout(5000),
  );
  assert.equal(corrected.calls[0]?.name, tool.name);
  assert.deepEqual(corrected.calls[0]?.arguments, { value: "test" });
  names = ["demo.not-advertised"];
  for await (const event of engine.stream(
    request,
    [tool],
    AbortSignal.timeout(5000),
  )) {
    if (event.type === "result") {
      assert.deepEqual(event.value.calls, []);
      assert.equal(
        (event.value.data as { incomplete: boolean }).incomplete,
        true,
      );
    }
  }
});

test("explicit provider refusal stops without dispatching partial tool calls or pretending no cost", async (t) => {
  const api = Fastify();
  t.after(() => api.close());
  let reason = "refusal",
    calls = 0;
  api.post("/v1/messages", async (_request, reply) => {
    calls++;
    const events = [
      {
        type: "message_start",
        message: {
          id: "refusal",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "unexecuted",
          name: "fixture",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"text":"partial' },
      },
      {
        type: "message_delta",
        delta: { stop_reason: reason },
        usage: { output_tokens: 8 },
      },
      { type: "message_stop" },
    ];
    return reply
      .type("text/event-stream")
      .send(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
      );
  });
  const engine = new PiEngine({
    baseUrl: await api.listen({ host: "127.0.0.1", port: 0 }),
    protocol: "anthropic",
    apiKey: "test-only",
    model: "claude-opus-5-5",
    inputPrice: 1,
    outputPrice: 1,
  });
  for (const mode of ["next", "stream"] as const)
    for (reason of ["refusal", "sensitive", "unknown_end"]) {
      const receipts: import("../packages/contracts/model-lifecycle.js").ModelReceipt[] =
        [];
      await assert.rejects(
        (async () => {
          const result = engine[mode](
            {
              instructions: "fixture",
              messages: [{ role: "user", text: "test" }],
              tools: [],
            },
            [],
            AbortSignal.timeout(5000),
            {
              principal: {
                id: "fixture",
                workspace_id: "fixture",
                role: "member",
                enabled: true,
                capabilities: [],
              },
              taskId: "fixture",
              report: async (receipt) => {
                receipts.push(receipt);
              },
            },
          );
          if (mode === "stream") {
            for await (const event of result as ReturnType<PiEngine["stream"]>)
              assert.notEqual(event.type, "result");
          } else await result;
        })(),
        reason === "unknown_end"
          ? { code: "MODEL_INCOMPLETE" }
          : { code: "MODEL_PROVIDER_REFUSAL", category: "permanent" },
      );
      assert.equal(
        receipts.at(-1)?.state,
        reason === "unknown_end" ? "unknown" : "completed",
      );
      assert.equal(
        receipts.at(-1)?.usage?.complete,
        false,
        "terminal decision does not guarantee complete usage",
      );
      assert.ok(receipts.at(-1)!.usage!.costUsd > 0);
    }
  assert.equal(
    calls,
    6,
    "one request per invocation; refusal must not automatically retry",
  );
});
