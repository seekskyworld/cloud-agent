/** 类型客户端使用真实 HTTP 验收，OpenAPI 的输入协议与路由校验共用 Schema。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import { CloudAgentClient } from "../packages/api/client.js";
import { openapi } from "../packages/api/openapi.js";
import { defineViews } from "../packages/ui/index.js";
import { setup, principal, token, otherToken, drain } from "./helpers.js";
test("公共客户端创建/重放/读取/下载/事件契约闭环，文档和附件受同样认证", async () => {
  const base = await setup(),
    directory = await mkdtemp(join(tmpdir(), "cloud-agent-api-"));
  const c = await createContainer({
    ...base.config,
    artifactConfig: { provider: "local", id: "api-files", directory },
    businesses: [
      {
        id: "starter",
        enabled: true,
        config: {},
        bindings: { output: "api-files" },
      },
    ],
  });
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_append(capabilities,'starter:run') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  const app = await createApp(c);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new CloudAgentClient({
    baseUrl: app.listeningOrigin,
    token: () => token,
  });
  try {
    assert.equal(
      (await app.inject({ url: "/v1/openapi.json" })).statusCode,
      401,
    );
    const spec = (
      await app.inject({
        url: "/v1/openapi.json",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/v1/tasks/{id}/reconciliation"]);
    assert.deepEqual(openapi("none").security, []);
    assert.equal(
      (await client.call("me", undefined)).principal.id,
      principal.id,
    );
    assert.ok(
      (await client.call("agents", undefined)).some(
        (a) => a.id === "starter-report",
      ),
    );
    const input = {
      moduleId: "starter-report",
      input: { text: "contract report" },
    };
    const task = await client.call("create", input, { key: "contract" });
    assert.equal(
      (await client.call("create", input, { key: "contract" })).id,
      task.id,
    );
    await assert.rejects(
      client.call(
        "create",
        { ...input, input: { text: "changed" } },
        { key: "contract" },
      ),
      /IDEMPOTENCY_CONFLICT/,
    );
    await drain(c);
    const detail = await client.call("detail", undefined, { id: task.id });
    assert.equal(detail.files.length, 1);
    assert.match(
      await (await client.downloadFile(detail.files[0]!.id)).text(),
      /contract report/,
    );
    assert.equal((await client.call("tasks", undefined)).length, 1);
    assert.ok(
      (await client.call("events", undefined, { id: task.id })).length > 0,
    );
    assert.ok(
      (
        await client.call("artifact", undefined, {
          id: detail.artifacts[0]!.id,
        })
      ).content,
    );
    const other = new CloudAgentClient({
      baseUrl: app.listeningOrigin,
      token: () => otherToken,
    });
    await assert.rejects(
      other.downloadFile(detail.files[0]!.id),
      /TASK_NOT_FOUND/,
    );
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_remove(capabilities,'starter:run') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    await assert.rejects(client.downloadFile(detail.files[0]!.id), /FORBIDDEN/);
  } finally {
    await app.close();
    await c.close();
    await base.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("客户端拒绝缺请求键/非法 ID/错误响应，页面注册拒绝同名覆盖", async () => {
  let calls = 0;
  const client = new CloudAgentClient({
    fetch: async () => {
      calls++;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(client.call("create", { moduleId: "x", input: {} }));
  assert.equal(calls, 0);
  await assert.rejects(client.call("detail", undefined, { id: "../bad" }));
  assert.equal(calls, 0);
  await assert.rejects(client.call("agents", undefined));
  assert.equal(calls, 1);
  assert.throws(
    () => defineViews([{ moduleId: "x" }, { moduleId: "x" }]),
    /DUPLICATE/,
  );
  assert.ok(defineViews([{ moduleId: "x" }]).x);
});

// 每个局部 Schema 引用须能在完整 OpenAPI 文档中解析，防止只校验 JSON 外观。
test("OpenAPI 递归 JSON Schema 引用能在完整文档中解析", () => {
  const spec = openapi("token");
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#")) {
        let target: unknown = spec;
        for (const part of item.slice(2).split("/")) {
          assert.ok(target && typeof target === "object");
          target = (target as Record<string, unknown>)[
            part.replace(/~1/g, "/").replace(/~0/g, "~")
          ];
        }
        assert.ok(target, item);
      } else visit(item);
    }
  };
  visit(spec);
});

test("默认 API 每分钟配额仍生效，宿主测试配额不影响生产默认", async () => {
  const c = await setup(),
    app = await createApp(c);
  try {
    for (let i = 0; i < 120; i++)
      assert.equal(
        (
          await app.inject({
            url: "/v1/me",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          url: "/v1/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      429,
    );
    assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
    assert.notEqual((await app.inject({ url: "/ready" })).statusCode, 429);
  } finally {
    await app.close();
    await c.close();
  }
});

// 验证客户端增补方法的认证、输入校验与错误行为，不依赖网络或数据库。
test("会话客户端增补复用认证且校验消息，失败不自动重试", async () => {
  let calls = 0;
  let response = Response.json([
    { id: 7, role: "assistant", content: { text: "hello" } },
  ]);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const client = new CloudAgentClient({
    baseUrl: "https://agent.example.test",
    token: () => "fixture-token",
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://agent.example.test/v1/conversations/${id}/messages`,
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-token",
      );
      return response;
    },
  });
  await assert.rejects(client.conversation("../invalid"));
  assert.equal(calls, 0);
  assert.deepEqual(await client.conversation(id), [
    { id: "7", role: "assistant", content: { text: "hello" } },
  ]);
  response = Response.json([{ id: 1, content: {} }]);
  await assert.rejects(client.conversation(id));
  response = Response.json({ error: "FORBIDDEN" }, { status: 403 });
  await assert.rejects(client.conversation(id), /FORBIDDEN/);
  assert.equal(calls, 3);
});
