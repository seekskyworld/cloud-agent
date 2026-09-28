import { pipelinePackage } from "./fixtures/pipeline-package.js";
/** 演进适配器契约只访问本机受控 HTTP 服务和临时文件。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, principal, drain } from "./helpers.js";
import { Connections } from "../packages/connections/index.js";
import { mcpTools } from "../adapters/mcp/index.js";
import { Registry } from "../packages/runtime/registry.js";
import { z } from "zod";
import { createContainer } from "../apps/container.js";
import { loadBusinessDeployments } from "../packages/business/index.js";
import { DataRetention } from "../packages/persistence/retention.js";
import {
  exportBundle,
  collectSecretReferences,
  verifyBundle,
  restoreObjects,
} from "../packages/recovery/index.js";
import { refreshingSecrets } from "../adapters/credentials/oauth.js";
const schema = {
  type: "object" as const,
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
test("MCP 初始化、工具清单和显式映射经过本地协议验证，不接受远端自动赋权", async (t) => {
  const calls: string[] = [];
  let sse = false,
    wrongId = false,
    deleted = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      deleted++;
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(message.method);
    res.setHeader("content-type", "application/json");
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: schema }] }
          : { structuredContent: { text: message.params.arguments.text } };
    if (message.method === "initialize")
      res.setHeader("mcp-session-id", "fixture-session");
    const response = {
      jsonrpc: "2.0",
      id: wrongId ? "incorrect-id" : message.id,
      result,
    };
    if (sse) {
      res.setHeader("content-type", "text/event-stream");
      res.write(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
      );
      res.write("event: message\ndata: " + JSON.stringify(response) + "\n\n");
      // 不主动结束 SSE，客户端取得匹配 ID 后应立即关闭流。
    } else res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connections = new Connections(
    [
      {
        id: "mcp",
        endpoint: `http://127.0.0.1:${address.port}`,
        credential: "test",
        grants: [
          {
            workspace: principal.workspace_id,
            principals: [principal.id],
            capability: "report:run",
          },
        ],
      },
    ],
    async () => ({ apiKey: "test" }),
    async () => principal,
  );
  const tools = mcpTools(connections, {
    connection: "mcp",
    tools: [
      {
        name: "mcp.echo",
        remoteName: "echo",
        version: "1",
        capability: "report:run",
        effect: "read",
        inputSchema: schema,
        outputSchema: schema,
      },
    ],
  });
  const registry = new Registry();
  registry.register({
    id: "mcp",
    version: "1",
    title: "mcp",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools,
    runtime: { model: false },
    next: () => ({ kind: "complete", result: null }),
  });
  assert.ok(registry.compatible().length);
  const outcome = await tools[0]!.execute(
    { text: "ok" },
    {
      principal,
      taskId: "t",
      runId: "r",
      invocationId: "i",
      idempotencyKey: "i",
      signal: new AbortController().signal,
    },
  );
  assert.deepEqual(outcome, { kind: "succeeded", output: { text: "ok" } });
  assert.deepEqual(calls, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  assert.equal(deleted, 1);
  sse = true;
  const context = {
    principal,
    taskId: "t",
    runId: "r",
    invocationId: "i",
    idempotencyKey: "i",
    signal: AbortSignal.timeout(3000),
  };
  assert.deepEqual(await tools[0]!.execute({ text: "sse" }, context), {
    kind: "succeeded",
    output: { text: "sse" },
  });
  assert.equal(deleted, 2);
  sse = false;
  wrongId = true;
  await assert.rejects(tools[0]!.execute({ text: "mismatch" }, context));
  assert.equal(deleted, 3);
});
test("中立测试包通过外部连接、模型、记忆上下文和文件存储端到端运行", async (t) => {
  const base = await setup();
  const directory = await mkdtemp(join(tmpdir(), "pipeline-fixture-"));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"value":42}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await base.db.pool.query(
    "UPDATE principals SET capabilities=capabilities || ARRAY['fixture-pipeline:run','memory:read','memory:write']",
  );
  const c = await createContainer(
    {
      ...base.config,
      memoryEnabled: true,
      artifactConfig: { provider: "local", id: "reports", directory },
      modelProfiles: [{ provider: "demo", id: "writer" }],
      connections: [
        {
          id: "source",
          endpoint: `http://127.0.0.1:${address.port}`,
          credential: "source",
          grants: [
            {
              workspace: principal.workspace_id,
              principals: [principal.id],
              capability: "fixture-pipeline:run",
            },
          ],
        },
      ],
      secrets: async () => ({ apiKey: "fixture" }),
      businesses: loadBusinessDeployments(
        '[{"id":"fixture-pipeline","bindings":{"source":"source","model":"writer","output":"reports","reference":"memory"}}]',
      ),
    },
    { businesses: [pipelinePackage] },
  );
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await c.close();
    await base.close();
    await rm(directory, { recursive: true, force: true });
  });
  const actor = await c.identity.current(principal.workspace_id, principal.id);
  await c.memories.put(
    actor,
    "pipeline",
    "Use concise summaries",
    1,
    "reference",
  );
  const task = await c.service.create(
    actor,
    "fixture-pipeline-run",
    {},
    "pipeline",
  );
  await drain(c);
  const detail = await c.service.detail(actor, task.id);
  assert.equal(detail.task.status, "succeeded", detail.task.error ?? "");
  assert.equal(detail.files.length, 1);
  assert.ok((await c.files!.get(actor, detail.files[0].id)).data.length);
});
test("正文退役保留幂等墓碑，禁止恢复旧任务或把旧请求重新执行", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const task = await c.service.create(
    principal,
    "report",
    { title: "private", values: [1] },
    "retire",
  );
  await drain(c);
  await c.db.pool.query(
    "UPDATE tasks SET updated_at=now()-interval '100 days' WHERE id=$1",
    [task.id],
  );
  const retention = new DataRetention(c.db);
  assert.equal((await retention.run(90, false, "test")).candidates.length, 1);
  assert.equal((await retention.run(90, true, "test")).retired, 1);
  await assert.rejects(
    c.service.create(
      principal,
      "report",
      { title: "private", values: [1] },
      "retire",
    ),
    /TASK_DATA_RETIRED/,
  );
  await assert.rejects(
    c.service.retry(principal, task.id),
    /TASK_DATA_RETIRED/,
  );
  assert.deepEqual((await c.tasks.get(principal, task.id)).input, {});
});
test("联合备份清单校验数据库与对象摘要，维护期间禁止新任务", async (t) => {
  const c = await setup(),
    root = await mkdtemp(join(tmpdir(), "recovery-bundle-"));
  t.after(async () => {
    await c.close();
    await rm(root, { recursive: true, force: true });
  });
  await c.db.pool.query("UPDATE platform_maintenance SET enabled=true");
  await assert.rejects(
    c.service.create(principal, "report", { values: [1] }, "maintenance"),
    /MAINTENANCE_ACTIVE/,
  );
  assert.equal(await c.worker.tick(), false);
  const path = join(root, "snapshot");
  await exportBundle(c.db, c.stores, path, async (destination) => {
    await writeFile(destination, "-- fixture SQL\n", { flag: "wx" });
  });
  assert.equal((await verifyBundle(path)).version, 1);
  assert.equal((await restoreObjects(c.db, c.stores, path)).restored, 0);
  const sql = join(path, "database.sql");
  await writeFile(sql, (await readFile(sql, "utf8")) + "tampered");
  await assert.rejects(verifyBundle(path), /DATABASE_CORRUPTED/);
});
test("OAuth 凭据代理串行刷新并持久化轮换令牌，未到期读取不刷新", async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(
      '{"access_token":"new","refresh_token":"rotated","expires_in":3600}',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let value = {
    version: "1",
    secret: {
      kind: "oauth2",
      refreshToken: "old",
      expiresAt: "2000-01-01T00:00:00.000Z",
    } as Record<string, unknown>,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const provider = refreshingSecrets(
    {
      read: async () => value,
      update: async (_ref, version, secret) => {
        assert.equal(version, value.version);
        value = { version: "2", secret };
      },
      exclusive: async (_ref, action) => {
        const pending = tail.then(action);
        tail = pending.catch(() => {});
        return pending;
      },
    },
    [
      {
        reference: "mail",
        tokenEndpoint: `http://127.0.0.1:${address.port}`,
        clientId: "fixture",
      },
    ],
  );
  const tokens = await Promise.all([provider("mail"), provider("mail")]);
  assert.equal(requests, 1);
  assert.equal(tokens[0]!.accessToken, "new");
  assert.equal(value.secret.refreshToken, "rotated");
});

test("恢复清单只收集凭据引用，不包含秘密值", () => {
  assert.deepEqual(
    collectSecretReferences({
      apiKey: "never-export",
      stores: [{ credential: "storage-key" }],
      mail: { credential: "mail-key", password: "never-export" },
      credentials: () => ({ apiKey: "never-export" }),
    }),
    ["mail-key", "storage-key"],
  );
});
