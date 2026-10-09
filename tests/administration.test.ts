/** 使用真实数据库验证分层授权、并发编辑、旧授权重放、审计及 Worker 撤权边界。 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Container } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import { bootstrapSuperadmin } from "../packages/identity/bootstrap.js";
import { tokenHash } from "../packages/persistence/database.js";
import { setup, principal, token, otherToken, drain } from "./helpers.js";
let c: Container;
let app: FastifyInstance;
const adminToken = "admin-integration-token";
const memberToken = "member-integration-token";
beforeEach(async () => {
  c = await setup();
  await bootstrapSuperadmin(
    c.db,
    principal.workspace_id,
    principal.id,
    "测试初始化",
  );
  await bootstrapSuperadmin(
    c.db,
    "workspace-b",
    principal.id,
    "另一工作区初始化",
  );
  for (const [id, role, auth] of [
    ["operator", "admin", adminToken],
    ["reader", "member", memberToken],
  ])
    await c.db.pool.query(
      "INSERT INTO principals(id,workspace_id,role,token_hash,capabilities) VALUES($1,$2,$3,$4,$5)",
      [id, principal.workspace_id, role, tokenHash(auth!), ["report:run"]],
    );
  app = await createApp(c);
});
afterEach(async () => {
  await app?.close();
  await c?.db.close();
});
const body = (id = "new-member") => ({
  id,
  role: "member",
  capabilities: ["report:run"],
  enabled: true,
  expectedVersion: null as number | null,
  reason: "业务接入授权",
});
const headers = (auth: string) => ({ authorization: `Bearer ${auth}` });
const get = (path: string, auth = token) =>
  app.inject({ url: `/v1${path}`, headers: headers(auth) });

async function send(payload: unknown, auth = token, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/principals",
    headers: {
      ...headers(auth),
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
}
test("成员不能进入管理面，管理员只读，超级管理员可授权；业务能力不等于管理角色", async () => {
  for (const path of ["/admin/catalog", "/admin/principals", "/admin/audit"]) {
    assert.equal((await get(path, memberToken)).statusCode, 403);
    assert.equal((await get(path, adminToken)).statusCode, 200);
  }
  assert.equal((await send(body(), adminToken)).statusCode, 403);
  assert.equal((await send(body(), memberToken)).statusCode, 403);
  assert.equal((await send({ ...body(), role: "admin" })).statusCode, 200);
  const me = (await get("/me")).json();
  assert.equal(me.principal.role, "superadmin");
  assert.ok(me.administration.includes("identity:manage"));
  await c.db.pool.query(
    "UPDATE principals SET capabilities=array_append(capabilities,'identity:manage') WHERE id='reader'",
  );
  assert.equal((await send(body("forged"), memberToken)).statusCode, 403);
  assert.ok(!(await get("/admin/principals")).body.includes("token_hash"));
});
test("超级管理员无业务通配权限，且不能读取他人的任务和产物", async () => {
  const reader = await c.identity.authenticate(memberToken);
  const task = await c.tasks.create(
    reader,
    "report",
    { title: "私有报告", values: [1] },
    randomUUID(),
  );
  await drain(c);
  const detail = await c.tasks.detail(reader, task.id);
  assert.equal((await get(`/tasks/${task.id}`)).statusCode, 404);
  assert.equal(
    (await get(`/artifacts/${detail.artifacts[0]!.id}`)).statusCode,
    404,
  );
  await c.db.pool.query(
    "UPDATE principals SET capabilities='{}' WHERE workspace_id=$1 AND id=$2",
    [principal.workspace_id, principal.id],
  );
  const rejected = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: { ...headers(token), "idempotency-key": randomUUID() },
    payload: { moduleId: "report", input: { values: [1] } },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal((await get("/admin/principals")).statusCode, 200);
});
test("受保护超级管理员不能通过 API 新建、降级、停用或更改能力", async () => {
  assert.equal((await send({ ...body(), role: "superadmin" })).statusCode, 400);
  for (const patch of [
    { role: "member" },
    { enabled: false },
    { capabilities: [] },
  ]) {
    const result = await send({
      ...body("owner"),
      expectedVersion: 2,
      ...patch,
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error, "SUPERADMIN_PROTECTED");
  }
  assert.equal((await get("/me")).json().principal.role, "superadmin");
});
test("工作区从操作者绑定，跨区目标不可编辑，目录与审计不泄露其他工作区", async () => {
  const created = await send(body("only-in-b"), otherToken);
  assert.equal(created.statusCode, 200);
  assert.equal(
    (await send({ ...body("only-in-b"), expectedVersion: 1 })).statusCode,
    404,
  );
  assert.equal(
    (await send({ ...body(), workspace_id: "workspace-b" })).statusCode,
    400,
  );
  assert.equal(
    (await get("/admin/principals?workspace_id=workspace-b")).statusCode,
    400,
  );
  assert.ok(!(await get("/admin/principals")).body.includes("only-in-b"));
  assert.ok(!(await get("/admin/audit")).body.includes("only-in-b"));
});
test("授权与审计原子记录，旧授权重放不会恢复后续撤权，同键异参拒绝", async () => {
  const key = randomUUID();
  const grant = { ...body(), role: "admin" };
  const created = await send(grant, token, key);
  assert.equal(created.statusCode, 200);
  const revoked = await send({
    ...body(),
    expectedVersion: created.json().access_version,
    capabilities: [],
    enabled: false,
  });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual((await send(grant, token, key)).json(), created.json());
  const current = (await get("/admin/principals"))
    .json()
    .find((row: { id: string }) => row.id === grant.id);
  assert.equal(current.enabled, false);
  assert.equal(current.role, "member");
  assert.equal(
    (await send({ ...grant, reason: "不同请求" }, token, key)).statusCode,
    409,
  );
  const events = (await get("/admin/audit"))
    .json()
    .filter((row: { target_id: string }) => row.target_id === grant.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].before_access.role, "admin");
  assert.equal(events[0].after_access.enabled, false);
  assert.ok(!JSON.stringify(events).includes("token_hash"));
});
test("并发修改只有一个版本成功，冲突不追加审计；未知能力和操作者注入被拒绝", async () => {
  const created = (await send(body())).json();
  const changes = await Promise.all([
    send({ ...body(), expectedVersion: created.access_version, role: "admin" }),
    send({
      ...body(),
      expectedVersion: created.access_version,
      enabled: false,
    }),
  ]);
  assert.deepEqual(changes.map((r) => r.statusCode).sort(), [200, 409]);
  for (const invalid of [
    { capabilities: ["*"] },
    { capabilities: ["identity:manage"] },
    { actorId: "owner" },
    { reason: "  " },
    { expectedVersion: -1 },
  ])
    assert.equal((await send({ ...body(), ...invalid })).statusCode, 400);
  assert.equal((await send(body())).statusCode, 409);
  assert.equal(
    (await get("/admin/audit"))
      .json()
      .filter((r: { target_id: string }) => r.target_id === body().id).length,
    2,
  );
});
test("管理员降级立即撤销管理读权限，成员停用立即拒绝原令牌", async () => {
  assert.equal(
    (await send({ ...body("operator"), expectedVersion: 1 })).statusCode,
    200,
  );
  assert.equal((await get("/admin/audit", adminToken)).statusCode, 403);
  assert.equal(
    (await send({ ...body("reader"), expectedVersion: 1, enabled: false }))
      .statusCode,
    200,
  );
  assert.equal((await get("/me", memberToken)).statusCode, 401);
  c.config.AUTH_MODE = "none";
  c.config.LOCAL_PRINCIPAL = "operator";
  assert.equal((await get("/admin/audit")).statusCode, 403);
});
test("撤销业务能力后排队任务不得继续执行，即使保留管理员角色", async () => {
  const actor = await c.identity.authenticate(adminToken);
  const task = await c.tasks.create(
    actor,
    "report",
    { title: "排队报告", values: [9] },
    randomUUID(),
  );
  assert.equal(
    (
      await send({
        ...body("operator"),
        role: "admin",
        expectedVersion: 1,
        capabilities: [],
      })
    ).statusCode,
    200,
  );
  await drain(c);
  assert.equal((await c.tasks.get(actor, task.id)).status, "failed");
  assert.equal((await get("/admin/catalog", adminToken)).statusCode, 200);
});
test("存储函数复核真实操作者，忽略伪造与已过期的角色快照", async () => {
  await assert.rejects(
    c.administration.change(
      { ...principal, id: "operator", role: "superadmin" },
      body(),
      randomUUID(),
    ),
    { code: "ADMINISTRATION_FORBIDDEN" },
  );
  await assert.rejects(
    c.db.pool.query(
      "SELECT manage_principal_access($1,$2,$3,'admin','{}',true,NULL,'越权',$4,$5)",
      [
        principal.workspace_id,
        "operator",
        "forged",
        randomUUID(),
        tokenHash("unusable"),
      ],
    ),
    /SUPERADMIN_REQUIRED/,
  );
  await assert.rejects(
    c.db.pool.query(
      "SELECT manage_principal_access($1,'owner','bad','superadmin','{}',true,NULL,'越权',$2,$3)",
      [principal.workspace_id, randomUUID(), tokenHash("unusable")],
    ),
    /INVALID_ACCESS_CHANGE/,
  );
  const root = await c.identity.authenticate(token);
  await c.db.pool.query(
    "UPDATE principals SET enabled=false WHERE id='owner' AND workspace_id=$1",
    [principal.workspace_id],
  );
  await assert.rejects(c.administration.change(root, body(), randomUUID()), {
    code: "IDENTITY_REVOKED",
  });
});
test("可信初始化可重入，保留业务能力，不复活禁用身份", async () => {
  await bootstrapSuperadmin(
    c.db,
    principal.workspace_id,
    "reader",
    "新增受保护管理员",
  );
  await bootstrapSuperadmin(
    c.db,
    principal.workspace_id,
    "reader",
    "重复初始化",
  );
  const reader = await c.identity.authenticate(memberToken);
  assert.equal(reader.role, "superadmin");
  assert.deepEqual(reader.capabilities, ["report:run"]);
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT 1 FROM administration_audit WHERE target_id='reader'",
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    bootstrapSuperadmin(c.db, principal.workspace_id, "missing", "不存在"),
    { code: "PRINCIPAL_NOT_FOUND" },
  );
  await assert.rejects(bootstrapSuperadmin(c.db, "", "reader", "缺少范围"));
  await c.db.pool.query(
    "UPDATE principals SET enabled=false WHERE id='reader'",
  );
  await assert.rejects(
    bootstrapSuperadmin(c.db, principal.workspace_id, "reader", "不可复活"),
    { code: "IDENTITY_REVOKED" },
  );
});

test("可信运维可显式替换受保护身份能力，同配置重入不重复审计", async () => {
  await bootstrapSuperadmin(
    c.db,
    principal.workspace_id,
    principal.id,
    "新模块接入",
    ["text:run"],
  );
  assert.deepEqual((await c.identity.authenticate(token)).capabilities, [
    "text:run",
  ]);
  await bootstrapSuperadmin(
    c.db,
    principal.workspace_id,
    principal.id,
    "重复配置",
    ["text:run"],
  );
  const events = await c.db.pool.query(
    "SELECT 1 FROM administration_audit WHERE workspace_id=$1 AND action='superadmin.configured'",
    [principal.workspace_id],
  );
  assert.equal(events.rowCount, 1);
  await assert.rejects(
    bootstrapSuperadmin(c.db, principal.workspace_id, principal.id, "坏能力", [
      " ",
    ]),
  );
});
