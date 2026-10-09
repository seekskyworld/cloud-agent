/** 新通用端口在真实 PostgreSQL 与 HTTP 边界上的闭环验收。 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createContainer, type Container } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import {
  setup,
  principal,
  token,
  otherToken,
  drain,
  expired,
} from "./helpers.js";
import { integrationExamples } from "../modules/examples/index.js";
import {
  MessageChannel,
  type ChannelMessage,
  type ChannelProvider,
} from "../packages/channels/channel.js";
import { SignedWebhook } from "../adapters/webhook/index.js";
import { verifyChannelContract } from "./extension-contracts.js";
import { DeliveryError } from "../packages/channels/delivery.js";
import { ArtifactFiles } from "../packages/artifacts/index.js";
import { LocalArtifacts } from "../adapters/artifacts/local.js";
import { Connections } from "../packages/connections/index.js";
import { admitConnection } from "../packages/runtime/admission.js";
import { ExecutionStore } from "../packages/persistence/execution.js";
import { Registry } from "../packages/runtime/registry.js";
import { ModelProfiles } from "../packages/runtime/models.js";
import { DemoEngine } from "../adapters/engine-pi/index.js";
import type {
  ExecutionContext,
  ModelEngine,
  Module,
} from "../packages/contracts/index.js";
import { z } from "zod";
let c: Container;
beforeEach(async () => {
  c = await setup();
});
afterEach(async () => {
  await c?.close();
});
const secret = "local-fixture-signing-key-never-used-outside-tests";
function signed(event: ChannelMessage) {
  const raw = Buffer.from(JSON.stringify(event)),
    stamp = Math.floor(Date.now() / 1000).toString();
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "x-channel-time": stamp,
      "x-channel-signature": createHmac("sha256", secret)
        .update(`${stamp}.`)
        .update(raw)
        .digest("hex"),
    },
  };
}
async function examples(files?: ArtifactFiles, connections?: Connections) {
  for (const m of integrationExamples({ files, connections }))
    c.registry.register(m);
  await c.db.pool.query(
    "UPDATE principals SET capabilities=capabilities||ARRAY['example:query','example:file','example:review']",
  );
}
function channel(
  provider: ChannelProvider,
  id = "hook",
  sendEnabled = true,
  moduleId = "message-review",
) {
  const settings = {
    id,
    workspace: principal.workspace_id,
    bindings: { alice: principal.id, bob: principal.id },
    moduleId,
    sendEnabled,
    identity: id,
  };
  return new MessageChannel(settings, provider, c.db, c.identity, c.service);
}
function context(taskId: string): ExecutionContext {
  return {
    principal,
    taskId,
    runId: randomUUID(),
    invocationId: randomUUID(),
    idempotencyKey: randomUUID(),
    signal: AbortSignal.timeout(10000),
  };
}
async function report() {
  return c.tasks.create(
    principal,
    "report",
    { title: "test", values: [1, 2] },
    randomUUID(),
  );
}

test("签名 Webhook 经 API 创建任务、等待、身份受限回复与结果通知", async () => {
  await examples();
  const sent: { id: string; payload: unknown }[] = [];
  const verifier = new SignedWebhook({ credential: "test" }, async () => ({
    signingKey: secret,
  }));
  const ch = channel({
    verify: (r, h) => verifier.verify(r, h),
    async send(id, payload) {
      sent.push({ id, payload });
    },
  });
  c.channels.push(ch);
  const app = await createApp(c);
  try {
    const event = {
        eventId: "e1",
        subject: "alice",
        threadId: "thread",
        input: { text: "请确认" },
      },
      request = signed(event);
    await verifyChannelContract(verifier, request.raw, request.headers);
    const post = () =>
      app.inject({
        method: "POST",
        url: "/hooks/channels/hook",
        headers: request.headers,
        payload: request.raw,
      });
    assert.equal((await post()).statusCode, 202);
    assert.equal((await post()).statusCode, 202);
    const bad = signed({ ...event, input: { text: "changed" } });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/hooks/channels/hook",
          headers: bad.headers,
          payload: bad.raw,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/hooks/channels/hook",
          headers: request.headers,
          payload: Buffer.concat([request.raw, Buffer.from(" ")]),
        })
      ).statusCode,
      401,
    );
    await Promise.all([ch.tick(), ch.tick()]);
    await drain(c);
    await ch.tick();
    assert.equal((await c.tasks.list(principal)).length, 1);
    assert.equal(sent.length, 1);
    const spoof = signed({
      eventId: "bad-reply",
      subject: "bob",
      threadId: "thread",
      input: {},
      replyTo: sent[0]!.id,
      response: { approved: true },
    });
    await ch.receive(spoof.raw, spoof.headers);
    await ch.tick();
    assert.equal(
      (await ch.status()).inbound.find((r) => r.id === "bad-reply")?.error,
      "CHANNEL_REPLY_FORBIDDEN",
    );
    const response = signed({
      eventId: "reply",
      subject: "alice",
      threadId: "thread",
      input: {},
      replyTo: sent[0]!.id,
      response: { approved: true },
    });
    await ch.receive(response.raw, response.headers);
    await ch.tick();
    await drain(c);
    await ch.tick();
    assert.equal((await c.tasks.list(principal))[0]!.status, "succeeded");
    assert.equal(sent.length, 2);
    assert.equal(
      (
        await app.inject({
          url: "/v1/admin/channels",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      403,
    );
    await c.db.pool.query(
      "UPDATE principals SET role='admin' WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    const admin = await app.inject({
      url: "/v1/admin/channels",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(admin.statusCode, 200);
    assert.ok(!admin.body.includes("请确认"));
  } finally {
    await app.close();
  }
});

test("未知投递不自动重发，超管人工确认必须复核身份并留下审计", async () => {
  await examples();
  let sends = 0;
  const provider = new SignedWebhook({ credential: "key" }, async () => ({
    signingKey: secret,
  }));
  const ch = channel({
    verify: (r, h) => provider.verify(r, h),
    async send() {
      sends++;
      throw new Error("remote may have accepted");
    },
  });
  const e = signed({
    eventId: "unknown",
    subject: "alice",
    threadId: "thread",
    input: { text: "review" },
  });
  await ch.receive(e.raw, e.headers);
  await ch.tick();
  await drain(c);
  await ch.tick();
  await ch.tick();
  assert.equal(sends, 1);
  const out = (await ch.status()).outbox[0]!;
  assert.equal(out.state, "uncertain");
  await assert.rejects(
    ch.resolve(
      { ...principal, role: "superadmin" },
      { target: out.id, resolution: "sent", reason: "verified" },
    ),
    { code: "FORBIDDEN" },
  );
  await c.db.pool.query(
    "UPDATE principals SET role='superadmin' WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await ch.resolve(
    { ...principal, role: "superadmin" },
    { target: out.id, resolution: "sent", reason: "verified remote" },
  );
  assert.equal(
    (await c.db.pool.query("SELECT * FROM channel_audit")).rowCount,
    1,
  );
  await assert.rejects(
    ch.resolve(
      { ...principal, role: "superadmin" },
      { target: out.id, resolution: "sent", reason: "again" },
    ),
    { code: "CHANNEL_STATE_CHANGED" },
  );
});

test("渠道草稿不外发，配置漂移拒绝恢复，撤权后不保留通知正文", async () => {
  await examples();
  const provider = new SignedWebhook({ credential: "key" }, async () => ({
    signingKey: secret,
  }));
  const ch = channel(provider, "draft", false),
    event = signed({
      eventId: "draft",
      subject: "alice",
      threadId: "thread",
      input: { text: "private" },
    });
  await ch.receive(event.raw, event.headers);
  await ch.tick();
  await drain(c);
  await ch.tick();
  assert.equal((await ch.status()).outbox[0]!.state, "draft");
  const changed = new MessageChannel(
    { ...ch.settings, identity: "different" },
    provider,
    c.db,
    c.identity,
    c.service,
  );
  await assert.rejects(changed.tick(), { code: "CHANNEL_ACCOUNT_CHANGED" });
  const second = channel(provider, "revoked", false);
  const e = signed({
    eventId: "second",
    subject: "alice",
    threadId: "second",
    input: { text: "do not deliver" },
  });
  await second.receive(e.raw, e.headers);
  await second.tick();
  await drain(c);
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'channel:use') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  await second.tick();
  const row = (
    await c.db.pool.query(
      "SELECT payload,state FROM channel_outbox WHERE account='revoked'",
    )
  ).rows[0]!;
  assert.equal(row.state, "cancelled");
  assert.deepEqual(row.payload, {});
});

test("明确拒绝与中断发送分开持久化，非法身份和输入被隔离", async () => {
  await examples();
  const verifier = new SignedWebhook({ credential: "k" }, async () => ({
    signingKey: secret,
  }));
  const ch = channel({
    verify: (r, h) => verifier.verify(r, h),
    async send() {
      throw new DeliveryError("REJECTED", true);
    },
  });
  for (const event of [
    {
      eventId: "invalid",
      subject: "nobody",
      threadId: "t",
      input: { text: "x" },
    },
    { eventId: "valid", subject: "alice", threadId: "t", input: { text: "x" } },
  ]) {
    const e = signed(event);
    await ch.receive(e.raw, e.headers);
  }
  await ch.tick();
  await drain(c);
  await ch.tick();
  assert.equal((await ch.status()).outbox[0]!.state, "failed");
  assert.equal(
    (await ch.status()).inbound.find((r) => r.id === "invalid")!.state,
    "quarantined",
  );
  await c.db.pool.query("UPDATE channel_outbox SET state='sending'");
  await ch.tick();
  assert.equal((await ch.status()).outbox[0]!.state, "uncertain");
});

test("文件示例完整执行，下载复核权限/摘要/有效期，过期对象可清理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-artifacts-")),
    store = new LocalArtifacts(dir, "test");
  const files = new ArtifactFiles(c.db, c.service, store);
  c.files = files;
  c.stores.set(store.id, files);
  await examples(files);
  const app = await createApp(c);
  try {
    const task = await c.service.create(
      principal,
      "file-report",
      { text: "hello world" },
      randomUUID(),
    );
    await drain(c);
    const done = await c.service.get(principal, task.id);
    assert.equal(done.status, "succeeded");
    const result = done.result as { id: string };
    assert.equal(
      (await files.get(principal, result.id)).data.toString(),
      "hello world",
    );
    const request = {
      url: `/v1/files/${result.id}`,
      headers: { authorization: `Bearer ${token}` },
    };
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).statusCode,
      404,
    );
    await assert.rejects(
      new ArtifactFiles(
        c.db,
        c.service,
        new LocalArtifacts(join(dir, "other"), "test"),
      ).get(principal, result.id),
      { code: "ARTIFACT_STORE_CHANGED" },
    );
    const row = (
      await c.db.pool.query("SELECT * FROM file_artifacts WHERE id=$1", [
        result.id,
      ])
    ).rows[0]!;
    await writeFile(join(dir, row.object_key), "corrupt");
    await assert.rejects(files.get(principal, result.id), {
      code: "ARTIFACT_INTEGRITY_FAILED",
    });
    await c.db.pool.query(
      "UPDATE file_artifacts SET expires_at=now()-interval '1 second'",
    );
    await assert.rejects(files.get(principal, result.id), {
      code: "ARTIFACT_EXPIRED",
    });
    assert.equal(await files.prune(), 1);
    assert.equal(await files.prune(), 0);
    await assert.rejects(files.get(principal, result.id), {
      code: "ARTIFACT_NOT_FOUND",
    });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("文件幂等写入拒绝改参，授权撤销立即阻止读写", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-artifacts-")),
    files = new ArtifactFiles(c.db, c.service, new LocalArtifacts(dir));
  try {
    const task = await report(),
      ctx = context(task.id),
      data = Buffer.from("original");
    const first = await files.put(ctx, "result.txt", "text/plain", data);
    const again = await files.put(ctx, "result.txt", "text/plain", data);
    assert.equal(first.id, again.id);
    await assert.rejects(
      files.put(ctx, "result.txt", "text/plain", Buffer.from("changed")),
      { code: "ARTIFACT_CONTENT_CHANGED" },
    );
    await assert.rejects(files.put(ctx, "../bad", "text/plain", data), {
      code: "ARTIFACT_METADATA_INVALID",
    });
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_remove(capabilities,'report:run') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    await assert.rejects(files.get(principal, first.id), { code: "FORBIDDEN" });
    await assert.rejects(files.put(ctx, "new.txt", "text/plain", data), {
      code: "FORBIDDEN",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API 查询示例使用受限连接，秘密轮换、跨工作区及撤权边界有效", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let key = "first";
  const connections = new Connections(
    [
      {
        id: "example-api",
        endpoint: `http://127.0.0.1:${address.port}`,
        credential: "test",
        grants: [
          {
            workspace: principal.workspace_id,
            principals: [principal.id],
            capability: "example:query",
          },
        ],
      },
    ],
    async () => ({ apiKey: key }),
    (w, id) => c.identity.current(w, id),
  );
  try {
    await examples(undefined, connections);
    for (const next of ["first", "second"]) {
      key = next;
      const task = await c.service.create(
        principal,
        "api-query",
        { path: "/status" },
        randomUUID(),
      );
      await drain(c);
      assert.equal(
        (await c.service.get(principal, task.id)).status,
        "succeeded",
      );
    }
    assert.deepEqual(seen, ["Bearer first", "Bearer second"]);
    await assert.rejects(
      connections.resolve("example-api", {
        ...principal,
        workspace_id: "workspace-b",
      }),
      { code: "CONNECTION_FORBIDDEN" },
    );
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_remove(capabilities,'example:query') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    await assert.rejects(connections.resolve("example-api", principal), {
      code: "FORBIDDEN",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("多 Worker 原子准入不越过工作区/模块上限，租约过期释放额度", async () => {
  const execution = new ExecutionStore(c.db, c.registry, 30000, {
    workspaceConcurrency: 2,
    modules: { report: 1 },
  });
  for (let i = 0; i < 6; i++) await report();
  const claims = (
    await Promise.all(Array.from({ length: 8 }, () => execution.claim("test")))
  ).filter((t) => !!t);
  assert.equal(claims.length, 1);
  await expired(c, claims[0]!);
  const restored = await execution.claim("test");
  assert.ok(restored);
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT count(*) FROM tasks WHERE status='running' AND lease_until>now()",
      )
    ).rows[0]!.count,
    "1",
  );
});

test("公平领取轮转工作区与模块，忙工作区不会连续占满队列", async () => {
  for (let i = 0; i < 4; i++) await report();
  const other = await c.tasks.create(
    { ...principal, workspace_id: "workspace-b" },
    "report",
    { title: "other", values: [1] },
    randomUUID(),
  );
  const text = await c.tasks.create(
    principal,
    "text",
    { text: "hello", instruction: "summarize" },
    randomUUID(),
  );
  const first = await c.execution.claim("test"),
    second = await c.execution.claim("test"),
    third = await c.execution.claim("test");
  assert.equal(first!.workspace_id, principal.workspace_id);
  assert.equal(second!.id, other.id);
  assert.equal(third!.id, text.id);
});

test("连接限流跨进程共享原子窗口，拒绝请求不读取凭据", async () => {
  // 固定此测试的共享窗口，避免断言期间跨自然分钟获得合法新配额；下方另行验证过期重置。
  await c.db.pool.query(
    "INSERT INTO connection_rates(id,window_start,count) VALUES('api',date_trunc('minute',now())+interval '1 hour',0)",
  );
  const allowed = await Promise.all(
    Array.from({ length: 20 }, () => admitConnection(c.db, "api", 3)),
  );
  assert.equal(allowed.filter(Boolean).length, 3);
  let reads = 0;
  const connections = new Connections(
    [
      {
        id: "api",
        endpoint: "https://example.invalid",
        credential: "key",
        ratePerMinute: 3,
        grants: [
          {
            workspace: principal.workspace_id,
            principals: [principal.id],
            capability: "report:run",
          },
        ],
      },
    ],
    async () => {
      reads++;
      return { apiKey: "test" };
    },
    (w, id) => c.identity.current(w, id),
    (id, n) => admitConnection(c.db, id, n),
  );
  await assert.rejects(connections.resolve("api", principal), {
    code: "CONNECTION_RATE_LIMITED",
  });
  assert.equal(reads, 0);
  await c.db.pool.query(
    "UPDATE connection_rates SET window_start=now()-interval '2 minutes'",
  );
  assert.equal(
    (await connections.resolve("api", principal)).secret.apiKey,
    "test",
  );
});

function modelModule(id: string, profile: string): Module {
  return {
    id,
    version: "1",
    title: id,
    description: id,
    capability: "text:run",
    input: z.object({}).strict(),
    example: {},
    tools: [],
    runtime: { model: true, modelProfile: profile },
    next(_input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output }
        : {
            kind: "model",
            key: "model",
            request: {
              instructions: "fixture",
              messages: [{ role: "user", text: "hello" }],
              tools: [],
            },
          };
    },
  };
}
test("模块选择不同模型，运行记录实际引擎，恢复指纹只绑定所选模型", async () => {
  const calls: string[] = [];
  function engine(id: string): ModelEngine {
    return {
      id,
      async next(_r, _t, _s, ctx) {
        assert.equal(ctx!.principal.id, principal.id);
        calls.push(id);
        return {
          text: id,
          calls: [],
          costUsd: 0,
          costEstimated: false,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  }
  const entries = [
      { id: "fast", engine: engine("fast-engine"), fingerprint: "fast-v1" },
      { id: "deep", engine: engine("deep-engine"), fingerprint: "deep-v1" },
    ],
    modules = [
      modelModule("fast-task", "fast"),
      modelModule("deep-task", "deep"),
    ];
  const child = await createContainer(c.config, {
    modules,
    modelProfiles: entries,
  });
  try {
    for (const module of modules)
      await child.service.create(principal, module.id, {}, randomUUID());
    await drain(child);
    assert.deepEqual(calls, ["fast-engine", "deep-engine"]);
    const runs = (
      await c.db.pool.query(
        "SELECT DISTINCT engine_id FROM runs ORDER BY engine_id",
      )
    ).rows;
    assert.deepEqual(
      runs.map((r) => r.engine_id),
      ["deep-engine", "fast-engine"],
    );
    const registry = new Registry("unrelated-default", {
      fast: "fast-v1",
      deep: "deep-v2",
    });
    for (const m of modules) registry.register(m);
    assert.equal(registry.hash(modules[0]!), child.registry.hash(modules[0]!));
    assert.notEqual(
      registry.hash(modules[1]!),
      child.registry.hash(modules[1]!),
    );
    const old = await child.service.create(
      principal,
      "deep-task",
      {},
      randomUUID(),
    );
    assert.equal(
      await new ExecutionStore(c.db, registry).claim("test"),
      undefined,
    );
    assert.equal((await child.tasks.get(principal, old.id)).status, "queued");
    assert.throws(
      () => new Registry().register(modules[0]!),
      /MODEL_PROFILE_NOT_FOUND/,
    );
    const profiles = new ModelProfiles(new DemoEngine(), entries);
    assert.equal(profiles.get("deep").id, "deep-engine");
    assert.throws(() => profiles.get("missing"));
    assert.throws(
      () => new ModelProfiles(new DemoEngine(), [entries[0]!, entries[0]!]),
      /MODEL_PROFILE_DUPLICATE/,
    );
  } finally {
    await child.close();
  }
});

test("装配中途失败也释放已创建扩展，显式渠道/邮件注入覆盖默认配置", async () => {
  const { modelProviders } = await import("../apps/models.js");
  const { defineExtension } = await import(
    "../packages/extensions/registry.js"
  );
  let closed = 0;
  const schema = z.object({
    id: z.string(),
    provider: z.literal("lifecycle-fixture"),
  });
  modelProviders.register(
    defineExtension<ModelEngine, Connections, typeof schema>({
      id: "lifecycle-fixture",
      schema,
      capabilities: ["text"],
      create: () => ({
        id: "lifecycle",
        next: async () => {
          throw new Error("unused");
        },
        close: async () => {
          closed++;
        },
      }),
    }),
  );
  await assert.rejects(
    createContainer(
      {
        ...c.config,
        modelProfiles: [{ id: "lifecycle", provider: "lifecycle-fixture" }],
      },
      { modules: [modelModule("invalid", "missing")] },
    ),
    /MODEL_PROFILE_NOT_FOUND/,
  );
  assert.equal(closed, 1);
  const provider: ChannelProvider = {
    verify: async () => {
      throw new Error("unused");
    },
    send: async () => {},
    close: async () => {
      closed++;
    },
  };
  const child = await createContainer(
    {
      ...c.config,
      channels: [
        {
          provider: "not-registered",
          id: "unused",
          workspace: "w",
          bindings: { a: "b" },
          moduleId: "text",
          sendEnabled: false,
          options: {},
        },
      ],
    },
    {
      mails: [],
      channels: [
        {
          settings: {
            id: "injected",
            workspace: "workspace-a",
            bindings: { a: "owner" },
            moduleId: "report",
            sendEnabled: false,
            identity: "fixture",
          },
          provider,
        },
      ],
    },
  );
  assert.equal(child.channels.length, 1);
  assert.equal(child.mails.length, 0);
  await child.close();
  await child.close();
  assert.equal(closed, 1);
});

test("文件写入失败留下可恢复元数据，清理跳过有效写入并在失败后重入", async () => {
  const objects = new Map<string, Buffer>();
  let failWrite = true,
    failRemove = true;
  const files = new ArtifactFiles(c.db, c.service, {
    id: "memory",
    identity: "test-memory",
    async put(key, data) {
      if (failWrite) throw new Error("interrupted");
      objects.set(key, data);
    },
    async get(key) {
      return objects.get(key)!;
    },
    async remove(key) {
      if (failRemove) throw new Error("interrupted");
      objects.delete(key);
    },
  });
  const task = await report(),
    ctx = context(task.id);
  await assert.rejects(
    files.put(ctx, "test.txt", "text/plain", Buffer.from("same")),
  );
  const pending = (await c.db.pool.query("SELECT * FROM file_artifacts"))
    .rows[0]!;
  await assert.rejects(files.get(principal, pending.id), {
    code: "ARTIFACT_NOT_READY",
  });
  failWrite = false;
  assert.equal(
    (await files.put(ctx, "test.txt", "text/plain", Buffer.from("same"))).id,
    pending.id,
  );
  await c.db.pool.query(
    "UPDATE file_artifacts SET expires_at=now()-interval '1 second',writing_until=now()+interval '1 minute'",
  );
  assert.equal(await files.prune(), 0);
  await c.db.pool.query(
    "UPDATE file_artifacts SET writing_until=now()-interval '1 second'",
  );
  await assert.rejects(files.prune());
  assert.equal(
    (await c.db.pool.query("SELECT state FROM file_artifacts")).rows[0]!.state,
    "deleting",
  );
  failRemove = false;
  assert.equal(await files.prune(), 0);
  await c.db.pool.query(
    "UPDATE file_artifacts SET writing_until=now()-interval '1 second'",
  );
  assert.equal(await files.prune(), 1);
  assert.equal(objects.size, 0);
});
