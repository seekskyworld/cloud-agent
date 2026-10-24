import { z } from "zod";
/** 本地 HTTP 网关验证真实 SDK 载荷、取消控制、状态丢失和流心跳；不调用外部模型。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { PiEngine } from "../adapters/engine-pi/index.js";
import {
  gatewayControl,
  verifyManagedResponse,
} from "../adapters/engine-pi/control.js";
import { modelDeadline } from "../packages/runtime/model-deadline.js";
import { principal } from "./helpers.js";
import type { ModelInvocation } from "../packages/contracts/model-lifecycle.js";
import { Connections } from "../packages/connections/index.js";
import { modelProviders } from "../apps/models.js";
const request = {
  instructions: "fixture",
  messages: [{ role: "user" as const, text: "fixture" }],
  tools: [],
  maxOutputTokens: 32,
};
function terminal(tokens = 1) {
  return `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: tokens, total_tokens: tokens + 1 } })}\n\ndata: [DONE]\n\n`;
}
const invocation = (): ModelInvocation => ({
  id: randomUUID(),
  operationKey: "operation",
  deadlineAt: Date.now() + 10000,
});
test("managed-v1 保留取消先到墓碑，重复请求不启动第二次，状态丢失保持 unknown", async (t) => {
  const app = Fastify();
  const states = new Map<string, string>();
  let accepted = 0;
  app.addHook("onRequest", async (req, reply) => {
    if (
      req.headers.authorization !== "Bearer fixture" ||
      req.headers["x-cloud-agent-scope"] !== "test"
    )
      return reply.code(403).send({});
  });
  app.delete("/model-requests/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    states.set(id, states.has(id) ? "transport_closed" : "not_started");
    return { state: states.get(id) };
  });
  app.get("/model-requests/:id", async (req, reply) => {
    const state = states.get((req.params as { id: string }).id);
    return state ? { state } : reply.code(404).send({});
  });
  app.post("/chat/completions", async (req, reply) => {
    const id = String(req.headers["x-cloud-agent-request-id"]);
    assert.equal(req.headers["x-cloud-agent-protocol"], "managed-v1");
    assert.ok(Number(req.headers["x-cloud-agent-deadline"]) > Date.now());
    if (states.has(id)) return reply.code(409).send({});
    states.set(id, "completed");
    accepted++;
    const body = req.body as { tools: unknown[]; reasoning_effort: string };
    assert.deepEqual(body.tools, []);
    assert.equal(body.reasoning_effort, "none");
    return reply
      .header("x-cloud-agent-protocol", "managed-v1")
      .header("x-cloud-agent-request-id", id)
      .type("text/event-stream")
      .send(terminal());
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    baseUrl,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
    managed: { scope: "test" },
  });
  const before = invocation();
  await engine.control!.cancel(before, AbortSignal.timeout(1000));
  await assert.rejects(
    engine.next(request, [], AbortSignal.timeout(1000), {
      principal,
      taskId: randomUUID(),
      invocation: before,
    }),
  );
  assert.equal(accepted, 0);
  const ref = invocation();
  let progress = 0;
  const result = await engine.next(request, [], AbortSignal.timeout(1000), {
    principal,
    taskId: randomUUID(),
    invocation: ref,
    progress: () => progress++,
  });
  assert.equal(result.text, "ok");
  assert.ok(progress > 0);
  assert.equal(accepted, 1);
  await assert.rejects(
    engine.next(request, [], AbortSignal.timeout(1000), {
      principal,
      taskId: randomUUID(),
      invocation: ref,
    }),
  );
  assert.equal(accepted, 1);
  states.clear();
  assert.deepEqual(
    await engine.control!.status(ref, AbortSignal.timeout(1000)),
    { state: "unknown" },
  );
  const wrong = gatewayControl(async () => ({ baseUrl, apiKey: "fixture" }), {
    scope: "other",
  });
  await assert.rejects(wrong.cancel(ref, AbortSignal.timeout(1000)));
  assert.throws(
    () => verifyManagedResponse(new Response("", { status: 200 }), ref.id),
    { code: "MODEL_CONTROL_NOT_ACKNOWLEDGED" },
  );
});
test("Pi 心跳流不能延长首包时限，拒绝供应商输出超限且没有隐式重试", async (t) => {
  const app = Fastify();
  let mode = "heartbeat",
    calls = 0;
  app.post("/chat/completions", async (_req, reply) => {
    calls++;
    if (mode === "over-limit")
      return reply.type("text/event-stream").send(terminal(64));
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write(": heartbeat\n\n");
    const timer = setInterval(() => reply.raw.write(": heartbeat\n\n"), 5);
    reply.raw.on("close", () => clearInterval(timer));
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    baseUrl,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
  });
  const deadline = modelDeadline(
    new AbortController().signal,
    Date.now() + 1000,
    50,
    50,
  );
  deadline.start();
  await assert.rejects(
    engine.next(request, [], deadline.signal, {
      principal,
      taskId: randomUUID(),
      progress: deadline.progress,
    }),
  );
  assert.equal(deadline.failure()?.code, "MODEL_FIRST_OUTPUT_TIMEOUT");
  deadline.close();
  assert.equal(calls, 1);
  mode = "over-limit";
  await assert.rejects(engine.next(request, [], AbortSignal.timeout(1000)), {
    code: "MODEL_OUTPUT_LIMIT",
  });
  assert.equal(calls, 2);
});

test("Pi 模型 profile 透传流式响应", async (t) => {
  const app = Fastify();
  const actor = {
    ...principal,
    capabilities: [...principal.capabilities, "text-assistant:run"],
  };
  app.post("/chat/completions", async (_req, reply) =>
    reply.type("text/event-stream").send(terminal()),
  );
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const connections = new Connections(
    [
      {
        id: "fixture",
        endpoint: baseUrl,
        credential: "fixture",
        grants: [
          {
            workspace: actor.workspace_id,
            principals: [actor.id],
            capability: "text-assistant:run",
          },
        ],
      },
    ],
    async () => ({ kind: "api-key", apiKey: "fixture" }),
    async () => actor,
  );
  const engine = await modelProviders.create(
    "pi",
    {
      provider: "pi",
      id: "fixture-profile",
      connection: "fixture",
      model: "fixture",
      inputPrice: 1,
      outputPrice: 1,
      protocol: "completions",
      reasoningLevels: ["none"],
    },
    connections,
  );
  assert.ok(engine.stream, "model profiles must expose stream");
  let text = "";
  for await (const chunk of engine.stream!(
    { ...request, stream: true },
    [],
    AbortSignal.timeout(1000),
    { principal: actor, taskId: randomUUID() },
  ))
    if (chunk.type === "text") text += chunk.text;
  assert.equal(text, "ok");
});

test("Pi 将视频内容块按时间顺序展开为视觉帧", async (t) => {
  const app = Fastify();
  let body: unknown;
  app.post("/chat/completions", async (request, reply) => {
    body = request.body;
    return reply.type("text/event-stream").send(terminal());
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    baseUrl,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
    video: true,
  });
  const observedTurn = await engine.next(
    {
      ...request,
      messages: [
        {
          role: "user",
          text: "读取视频",
          content: [
            {
              type: "video",
              mediaType: "video/x-frame-sequence",
              durationSeconds: 2,
              frames: [
                {
                  mediaType: "image/jpeg",
                  data: Buffer.from("frame-0".repeat(15000)).toString("base64"),
                  timestampSeconds: 0,
                },
                {
                  mediaType: "image/jpeg",
                  data: Buffer.from("frame-1").toString("base64"),
                  timestampSeconds: 1,
                },
              ],
            },
          ],
        },
      ],
    },
    [],
    AbortSignal.timeout(1000),
  );
  const receipt = (
    observedTurn.data as {
      inputReceipt: {
        transmittedImageCount: number;
        httpAccepted: boolean;
        omitted: unknown[];
      };
    }
  ).inputReceipt;
  assert.equal(receipt.transmittedImageCount, 2);
  assert.equal(receipt.httpAccepted, true);
  assert.equal(receipt.omitted.length, 0);
  const payload = JSON.stringify(body);
  assert.match(payload, /视频附件/);
  assert.match(payload, /data:image\/jpeg;base64/);
  assert.ok(
    payload.indexOf(Buffer.from("frame-0".repeat(15000)).toString("base64")) <
      payload.indexOf(Buffer.from("frame-1").toString("base64")),
  );
});

test("Pi streaming counts real thinking and tool deltas as progress without exposing reasoning", async (t) => {
  const app = Fastify();
  const tool = {
    name: "fixture",
    version: "1",
    description: "fixture",
    input: z.object({ value: z.string() }),
    output: z.string(),
    capability: "fixture",
    effect: "read" as const,
    timeoutMs: 1000,
    execute: async () => ({ kind: "succeeded" as const, output: "ok" }),
  };
  app.post("/v1/messages", async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: Record<string, unknown>) =>
      reply.raw.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    send({
      type: "message_start",
      message: {
        id: "fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    send({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private test reasoning " },
      });
    }
    send({ type: "content_block_stop", index: 0 });
    send({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "call",
        name: "fixture",
        input: {},
      },
    });
    send({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"value":"ok"}' },
    });
    send({ type: "content_block_stop", index: 1 });
    send({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 16 },
    });
    send({ type: "message_stop" });
    reply.raw.end();
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const engine = new PiEngine({
    protocol: "anthropic",
    baseUrl,
    apiKey: "fixture",
    model: "fixture",
    inputPrice: 1,
    outputPrice: 1,
  });
  const deadline = modelDeadline(
    new AbortController().signal,
    Date.now() + 3000,
    150,
    150,
  );
  t.after(() => deadline.close());
  deadline.start();
  const chunks = [];
  let progress = 0;
  for await (const chunk of engine.stream(
    { ...request, stream: true, tools: [tool.name] },
    [tool],
    deadline.signal,
    {
      principal,
      taskId: randomUUID(),
      progress: () => {
        progress++;
        deadline.progress();
      },
    },
  ))
    chunks.push(chunk);
  assert.ok(progress >= 7);
  assert.equal(deadline.failure(), undefined);
  assert.equal(
    chunks.some((c) => c.type === "text"),
    false,
  );
  assert.equal(
    JSON.stringify(chunks).includes("private test reasoning"),
    false,
  );
  const last = chunks.at(-1)!;
  assert.equal(last.type, "result");
  if (last.type === "result")
    assert.deepEqual(last.value.calls[0]?.arguments, { value: "ok" });
});
