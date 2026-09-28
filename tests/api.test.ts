/** HTTP 契约验证认证、资源隔离、输入防注入和事件游标。 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Container } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import { setup, token, otherToken, principal, drain } from "./helpers.js";
let c: Container;
let app: FastifyInstance;
beforeEach(async () => {
  c = await setup();
  app = await createApp(c);
});
afterEach(async () => {
  await app?.close();
  await c?.db.close();
});
const headers = { authorization: `Bearer ${token}` };
test("免登录使用固定身份完成任务，客户端不能切换工作区", async () => {
  c.config.AUTH_MODE = "none";
  const me = await app.inject("/v1/me");
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authMode, "none");
  assert.equal(me.json().principal.workspace_id, "workspace-a");
  assert.equal(me.json().principal.id, "owner");
  const spoofed = await app.inject({
    url: "/v1/me",
    headers: {
      authorization: `Bearer ${otherToken}`,
      "x-workspace-id": "workspace-b",
    },
  });
  assert.equal(spoofed.json().principal.workspace_id, "workspace-a");
  const result = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { "idempotency-key": randomUUID() },
    payload: {
      moduleId: "report",
      input: { title: "免登录报告", values: [2, 4] },
    },
  });
  assert.equal(result.statusCode, 202);
  await drain(c);
  const detail = await app.inject(`/v1/tasks/${result.json().id}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().task.result.sum, 6);
  assert.equal(
    (
      await post("/tasks", {
        moduleId: "report",
        input: { values: [1] },
        workspaceId: "workspace-b",
      })
    ).statusCode,
    400,
  );
});
test("免登录仍检查当前能力和身份启用状态", async () => {
  c.config.AUTH_MODE = "none";
  await c.db.pool.query(
    "UPDATE principals SET capabilities='{}' WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  assert.equal(
    (await post("/tasks", { moduleId: "report", input: { values: [1] } }))
      .statusCode,
    403,
  );
  await c.db.pool.query(
    "UPDATE principals SET enabled=false WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  assert.equal((await app.inject("/v1/me")).statusCode, 403);
});
async function post(path: string, payload: unknown, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/v1${path}`,
    headers: {
      ...headers,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
}

test("未登录、错误令牌和伪造身份参数被拒绝", async () => {
  assert.equal((await app.inject("/v1/tasks")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/v1/tasks",
        headers: { authorization: "Bearer invalid" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await post("/tasks", {
        moduleId: "report",
        input: { values: [1] },
        principalId: "admin",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers,
        payload: { moduleId: "report", input: { values: [1] } },
      })
    ).statusCode,
    400,
  );
});
test("任务、会话和产物 API 完整闭环，跨工作区隔离", async () => {
  const result = await post("/tasks", {
    moduleId: "report",
    input: { title: "API 测试", values: [2, 4] },
  });
  assert.equal(result.statusCode, 202);
  const { id, conversationId } = result.json();
  await drain(c);
  const detail = await app.inject({ url: `/v1/tasks/${id}`, headers });
  assert.equal(detail.statusCode, 200);
  const body = detail.json();
  assert.equal(
    (await app.inject({ url: "/v1/tasks", headers })).json().length,
    1,
  );
  assert.equal(
    (await app.inject({ url: "/v1/conversations", headers })).json().length,
    1,
  );
  assert.equal(
    (await app.inject({ url: "/v1/agents", headers })).json().length,
    4,
  );
  assert.equal(
    (await app.inject({ url: "/v1/me", headers })).json().principal.id,
    "owner",
  );
  assert.equal(body.task.result.sum, 6);
  const artifact = await app.inject({
    url: `/v1/artifacts/${body.artifacts[0].id}`,
    headers,
  });
  assert.equal(artifact.statusCode, 200);
  const other = { authorization: `Bearer ${otherToken}` };
  assert.equal(
    (
      await app.inject({
        url: `/v1/artifacts/${body.artifacts[0].id}`,
        headers: other,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: `/v1/tasks/${id}/events`, headers: other }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: `/v1/conversations/${conversationId}/messages`,
        headers,
      })
    ).json().length,
    2,
  );
});
test("事件 SSE 与游标分页保持相同持久顺序", async () => {
  const { id } = (
    await post("/tasks", {
      moduleId: "report",
      input: { title: "事件", values: [1] },
    })
  ).json();
  await drain(c);
  const events = (
    await app.inject({ url: `/v1/tasks/${id}/events?format=json`, headers })
  ).json();
  assert.ok(events.length >= 4);
  const cursor = events[1].id;
  const replay = (
    await app.inject({ url: `/v1/tasks/${id}/events?after=${cursor}`, headers })
  ).body;
  assert.ok(replay.includes(`id: ${events[2].id}\n`));
  assert.ok(!replay.includes(`id: ${events[0].id}\n`));
  assert.equal(
    (await app.inject({ url: `/v1/tasks/${id}/events?after=-1`, headers }))
      .statusCode,
    400,
  );
});
test("错误等待响应及跨任务 wait ID 不能唤醒", async () => {
  const { id } = (
    await post("/tasks", { moduleId: "report", input: { values: [1] } })
  ).json();
  await drain(c);
  const wait = (await c.tasks.detail(principal, id)).waits[0]!;
  assert.equal(
    (
      await post(`/tasks/${id}/inputs`, {
        waitId: wait.id,
        response: { wrong: "field" },
      })
    ).statusCode,
    400,
  );
  const other = (
    await post("/tasks", { moduleId: "report", input: { values: [2] } })
  ).json();
  assert.equal(
    (
      await post(`/tasks/${other.id}/inputs`, {
        waitId: wait.id,
        response: { title: "注入" },
      })
    ).statusCode,
    404,
  );
  assert.equal((await c.tasks.get(principal, id)).status, "waiting_input");
});
test("禁用身份立即失去访问，撤销模块权限不能读取缓存产物", async () => {
  const task = await c.tasks.create(
    principal,
    "text",
    { text: "测试", instruction: "概括" },
    randomUUID(),
  );
  await drain(c);
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'text:run') WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  assert.equal(
    (await app.inject({ url: `/v1/tasks/${task.id}`, headers })).statusCode,
    403,
  );
  await c.db.pool.query(
    "UPDATE principals SET enabled=false WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  assert.equal(
    (await app.inject({ url: "/v1/tasks", headers })).statusCode,
    401,
  );
});
test("ready 检查 Worker 心跳，指标需要运维权限", async () => {
  assert.equal((await app.inject("/ready")).statusCode, 503);
  await c.operations.heartbeat("test");
  await c.operations.loopHeartbeat("test", "maintenance");
  assert.equal((await app.inject("/ready")).statusCode, 200);
  assert.ok(
    (await app.inject({ url: "/v1/metrics", headers })).body.includes(
      "cloud_agent_workers 1",
    ),
  );
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_remove(capabilities,'operations:read')",
  );
  assert.equal(
    (await app.inject({ url: "/v1/metrics", headers })).statusCode,
    403,
  );
});

test("readiness 数据库不可达时返回 503，健康检查仍可响应", async () => {
  c.operations.ready = async () => {
    throw new Error("database unavailable");
  };
  const response = await app.inject("/ready");
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    database: false,
    worker: false,
    maintenance: false,
  });
  assert.equal((await app.inject("/health")).statusCode, 200);
});
