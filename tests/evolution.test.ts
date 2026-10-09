/** 演进验收覆盖故障边界，使用受控供应器与隔离数据库。 */
import test from "node:test";
import assert from "node:assert/strict";
import { bounded } from "../packages/contracts/lifecycle.js";
import { runLoop } from "../packages/runtime/loop.js";
import { ChannelHub } from "../packages/channels/hub.js";
import type { MessageChannel } from "../packages/channels/channel.js";
test("扩展不响应 signal 仍截止；父级撤销传播，迟到异常不泄漏", async () => {
  await assert.rejects(
    bounded(10, () => new Promise(() => {})),
    /DEADLINE/,
  );
  const parent = new AbortController();
  parent.abort(new Error("lease gone"));
  let called = false;
  await assert.rejects(
    bounded(
      10,
      async () => {
        called = true;
      },
      parent.signal,
    ),
    /lease gone/,
  );
  assert.equal(called, false);
  assert.equal(await bounded(50, async () => 42), 42);
});
test("循环断连后恢复，认证或迁移配置错误立即上抛", async () => {
  let calls = 0;
  const errors: (string | null)[] = [];
  const operations = {
    loopHeartbeat: async (
      _id: string,
      _kind: string,
      error: string | null = null,
    ) => {
      errors.push(error);
    },
  };
  await runLoop({
    id: "test",
    kind: "execute",
    operations,
    intervalMs: 1,
    stopping: () => calls >= 2,
    tick: async () => {
      if (++calls === 1)
        throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
    },
  });
  assert.deepEqual(errors, ["CYCLE_FAILED", null]);
  await assert.rejects(
    runLoop({
      id: "test",
      kind: "execute",
      operations,
      intervalMs: 1,
      stopping: () => false,
      tick: async () => {
        throw Object.assign(new Error("bad schema"), { code: "42P01" });
      },
    }),
    /bad schema/,
  );
});
test("一个慢渠道不阻挡其他账户，持锁并发最多两个且不重复启动同账户", async () => {
  let release!: () => void;
  let slowCalls = 0,
    fastCalls = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channels = [
    {
      settings: { id: "slow" },
      tick: async () => {
        slowCalls++;
        await pending;
      },
    },
    {
      settings: { id: "fast" },
      tick: async () => {
        fastCalls++;
      },
    },
  ] as MessageChannel[];
  const hub = new ChannelHub(
    channels,
    { loopHeartbeat: async () => {} },
    "test",
  );
  await hub.tick();
  await hub.tick();
  assert.equal(slowCalls, 1);
  assert.equal(fastCalls, 2);
  release();
  await hub.close();
});

import { setup, principal, token, otherToken, drain } from "./helpers.js";
import { createContainer } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import { loadBusinessDeployments } from "../packages/business/index.js";
import { migrateBusiness } from "../packages/persistence/business.js";
import { recordsPackage } from "./fixtures/records-package.js";
import { recordsBinding } from "./fixtures/records-store.js";
test("业务包独立迁移、API、领域幂等、版本冲突、跨工作区隔离和定时任务闭环", async (t) => {
  const base = await setup();
  const deployments = loadBusinessDeployments(
    JSON.stringify([
      {
        id: "fixture-records",
        bindings: { records: "records" },
        jobs: {
          snapshot: {
            workspace: principal.workspace_id,
            principal: principal.id,
          },
        },
      },
    ]),
  );
  await migrateBusiness(base.db, recordsPackage);
  await migrateBusiness(base.db, recordsPackage);
  await assert.rejects(
    migrateBusiness(base.db, {
      ...recordsPackage,
      migrations: [{ id: "001_records", sql: "SELECT 1" }],
    }),
    /MIGRATION_CHANGED/,
  );
  await base.db.pool.query(
    "UPDATE principals SET capabilities=capabilities || ARRAY['fixture:read','fixture:write']",
  );
  const c = await createContainer(
    { ...base.config, businesses: deployments },
    {
      businesses: [recordsPackage],
      ports: { records: recordsBinding(base.db) },
    },
  );
  const app = await createApp(c);
  t.after(async () => {
    await app.close();
    await c.close();
    await base.close();
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "idempotency-key": "write-record",
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/business/fixture-records/write",
    headers,
    payload: { id: "record", value: "test", expectedVersion: 0 },
  });
  assert.equal(created.statusCode, 200, created.body);
  const record = created.json();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/business/fixture-records/write",
        headers,
        payload: { id: "record", value: "test", expectedVersion: 0 },
      })
    ).json().id,
    record.id,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/business/fixture-records/write",
        headers,
        payload: { id: "record", value: "changed", expectedVersion: 0 },
      })
    ).statusCode,
    409,
  );
  const list = await app.inject({
    url: "/v1/business/fixture-records/list",
    headers,
  });
  assert.equal(list.json().length, 1);
  assert.deepEqual(
    (
      await app.inject({
        url: "/v1/business/fixture-records/list",
        headers: { authorization: `Bearer ${otherToken}` },
      })
    ).json(),
    [],
  );
  const update = {
    id: record.id,
    expectedVersion: 1,
    value: "updated",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/business/fixture-records/write",
        headers: { ...headers, "idempotency-key": "update" },
        payload: update,
      })
    ).json().version,
    2,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/business/fixture-records/write",
        headers: { ...headers, "idempotency-key": "stale" },
        payload: update,
      })
    ).statusCode,
    409,
  );
  await Promise.all([c.businessJobs.tick(), c.businessJobs.tick()]);
  assert.equal((await c.tasks.list(principal)).length, 1);
  await drain(c);
  assert.equal((await c.tasks.list(principal))[0]!.status, "succeeded");
  const audit = await c.db.pool.query(
    "SELECT outcome FROM business_requests WHERE package_id='fixture-records'",
  );
  assert.ok(audit.rows.some((r) => r.outcome === "succeeded"));
  assert.ok(audit.rows.some((r) => r.outcome === "unconfirmed"));
  const [job] = await c.businessJobs.list(principal.workspace_id);
  const change = {
    id: job!.id,
    expectedHash: job!.currentHash!,
    enabled: false,
    reason: "pause schedule",
  };
  await c.businessJobs.change(principal, "pause-job", change);
  await c.businessJobs.change(principal, "pause-job", change);
  await c.db.pool.query(
    "UPDATE business_jobs SET next_at=now()-interval '1 day'",
  );
  await c.businessJobs.tick();
  assert.equal((await c.tasks.list(principal)).length, 1);
  await assert.rejects(
    c.businessJobs.change(principal, "pause-job", { ...change, enabled: true }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const navigation = (
    await app.inject({ url: "/v1/business", headers })
  ).json();
  assert.equal(navigation[0].pages[0].id, "records");
  await c.db.pool.query(
    "UPDATE principals SET capabilities='{}' WHERE workspace_id=$1",
    [principal.workspace_id],
  );
  assert.equal(
    (await app.inject({ url: "/v1/business/fixture-records/list", headers }))
      .statusCode,
    403,
  );
});
test("有心跳但模块版本不兼容不能让 API 假就绪，空队列不构成故障", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  await c.operations.heartbeat("worker");
  await c.operations.loopHeartbeat("worker", "maintenance");
  assert.equal((await c.operations.ready()).compatible, true);
  await c.db.pool.query("UPDATE worker_heartbeats SET modules='[]'");
  assert.equal((await c.operations.ready()).compatible, false);
  await c.operations.heartbeat("worker");
  assert.equal((await c.operations.ready()).compatible, true);
});

import {
  ProcessExecutionHost,
  isolateModule,
} from "../packages/execution-host/index.js";
import { createModule } from "./fixtures/isolated-module.js";
import { ToolBroker } from "../packages/tool-execution/broker.js";
import type { Step } from "../packages/contracts/index.js";
test("独立进程可终止 CPU 死循环，不继承凭据，进程崩溃的写入仍为未知", async (t) => {
  const host = new ProcessExecutionHost(2);
  t.after(() => host.close());
  const spec = {
    entry: new URL("./fixtures/isolated-module.ts", import.meta.url).href,
    exportName: "createModule",
    revision: "test",
    timeoutMs: 2000,
  };
  const signal = new AbortController().signal;
  const result = await host.invoke(spec, "next", [{}, []], signal);
  assert.deepEqual(result, { kind: "complete", result: { safe: true } });
  let progressed = false;
  const blocking = host.invoke(
    { ...spec, config: { behavior: "block" }, timeoutMs: 1000 },
    "next",
    [{}, []],
    signal,
  );
  setTimeout(() => {
    progressed = true;
  }, 10);
  await assert.rejects(blocking, /Execution failed/);
  assert.equal(progressed, true);
  const module = isolateModule({ ...createModule({}), execution: spec }, host);
  const outcome = await new ToolBroker().execute(
    module.tools[0]!,
    {},
    {
      principal,
      taskId: "fixture",
      runId: "fixture",
      invocationId: "fixture",
      idempotencyKey: "fixture",
      signal,
    },
    { id: "fixture", status: "pending" } as Step,
  );
  assert.deepEqual(outcome, { kind: "unknown", reconciliationRef: "fixture" });
  await host.close();
  await assert.rejects(
    host.invoke(spec, "next", [{}, []], signal),
    /Execution failed/,
  );
});

import {
  Deployments,
  revisionId,
  deploymentDiff,
} from "../packages/deployment/index.js";
test("部署修订不可变、切换有并发保护，停用旧入口不改写旧任务快照", async (t) => {
  const base = await setup();
  t.after(() => base.close());
  const c = await createContainer({ ...base.config, managedDeployment: true });
  t.after(() => c.close());
  const deployments = new Deployments(c.db),
    manifest = c.registry.deployment();
  await assert.rejects(
    c.service.create(principal, "report", { values: [1] }, "before"),
    /DEPLOYMENT_NOT_ACTIVE/,
  );
  const first = await deployments.stage(manifest);
  assert.equal(first, revisionId(manifest));
  await deployments.activate(first, null, "test", "first deploy");
  const task = await c.service.create(
    principal,
    "report",
    { values: [1] },
    "after",
  );
  c.registry.get("report").budget = { maxSteps: 10 };
  const next = c.registry.deployment();
  assert.ok(deploymentDiff(manifest, next).changed.length);
  const second = await deployments.stage(next);
  await assert.rejects(
    deployments.activate(second, null, "test", "stale"),
    /VERSION_CONFLICT/,
  );
  await assert.rejects(
    deployments.activate(second, first, "test", "unsafe upgrade"),
    /IN_FLIGHT_INCOMPATIBLE/,
  );
  await deployments.activate(
    second,
    first,
    "test",
    "upgrade retaining old worker",
    { retained: manifest.modules },
  );
  const row = (
    await c.db.pool.query(
      "SELECT deployment_revision,config_hash FROM tasks WHERE id=$1",
      [task.id],
    )
  ).rows[0];
  assert.equal(row.deployment_revision, first);
  assert.equal(row.config_hash, task.config_hash);
  await deployments.activate(first, second, "test", "rollback code separately");
  assert.equal((await deployments.current())!.id, first);
});

import { WorkspaceCosts } from "../packages/observability/costs.js";
import { Telemetry } from "../packages/observability/tracing.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { evaluate } from "../packages/runtime/evaluation.js";
test("并发任务共享月度成本上限，未知调用继续占额，已知费用释放余额", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const task = await c.service.create(
    principal,
    "text",
    { text: "x", instruction: "echo" },
    "cost",
  );
  const costs = new WorkspaceCosts(c.db, {
    workspaces: { [principal.workspace_id]: 1 },
  });
  const results = await Promise.allSettled([
    costs.reserve(task, "one", 0.75),
    costs.reserve(task, "two", 0.75),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const row = (
    await c.db.pool.query("SELECT invocation FROM cost_reservations")
  ).rows[0];
  await costs.settle(row.invocation, 0.2, false);
  await costs.reserve(task, "third", 0.75);
  const rows = await costs.snapshot(principal.workspace_id);
  assert.equal(rows[0].pending, 0.75);
  await assert.rejects(costs.reserve(task, "fourth", 0.1), /COST_LIMIT/);
});
test("Trace 关联父子任务标识，默认无正文；离线评测校验质量、成本与截止", async () => {
  const exporter = new InMemorySpanExporter(),
    telemetry = new Telemetry(exporter);
  await telemetry.run("request", { "request.id": "r" }, async () => {
    await telemetry.run("task", { "task.id": "t" }, async () =>
      assert.ok(telemetry.current()?.traceId),
    );
  });
  // shutdown 会清空内存导出器；先保存 export 接收到的只读快照。
  const spans: { name: string; traceId: string; parent?: string }[] = [];
  const original = exporter.export.bind(exporter);
  exporter.export = (batch, callback) => {
    spans.push(
      ...batch.map((s) => ({
        name: s.name,
        traceId: s.spanContext().traceId,
        parent: s.parentSpanContext?.traceId,
      })),
    );
    original(batch, callback);
  };
  await telemetry.close();
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.traceId, spans[1]!.traceId);
  const result = await evaluate(
    [
      {
        id: "sample",
        version: "1",
        input: [1, 2],
        expected: 3,
        maxCostUsd: 0,
        maxLatencyMs: 100,
      },
    ],
    {
      mode: "offline",
      run: async () => ({ output: 3, costUsd: 0, tools: ["sum"] }),
    },
  );
  assert.equal(result.passed, true);
});

import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { OidcIdentityProvider } from "../adapters/identity/oidc.js";
import { tokenHash } from "../packages/persistence/database.js";
import { z } from "zod";
import {
  prepareModelRequest,
  invokeModel,
} from "../packages/runtime/model-request.js";
import type { Module, ModelEngine } from "../packages/contracts/index.js";
test("OIDC 校验签名/发行方/受众/期限，主体映射固定且令牌可撤销", async (t) => {
  const keys = await generateKeyPair("ES256"),
    jwk = await exportJWK(keys.publicKey);
  const config = {
    issuer: "https://identity.invalid",
    audience: "cloud-agent",
    jwksUrl: "https://identity.invalid/jwks",
    subjects: [
      {
        subject: "subject",
        workspace: principal.workspace_id,
        principal: principal.id,
      },
    ],
  };
  const provider = new OidcIdentityProvider(
    config,
    createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256" }] }),
  );
  const sign = (audience: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(config.issuer)
      .setAudience(audience)
      .setSubject("subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  assert.deepEqual(
    await provider.authenticate(
      `Bearer ${await sign(config.audience)}`,
      new AbortController().signal,
    ),
    { workspace: principal.workspace_id, principal: principal.id },
  );
  await assert.rejects(
    provider.authenticate(
      `Bearer ${await sign("wrong")}`,
      new AbortController().signal,
    ),
    /OIDC_TOKEN_INVALID/,
  );
  const c = await setup();
  t.after(() => c.close());
  const credential = await c.tokens.create(principal, "service", 1);
  assert.equal(
    (await c.identity.authenticate(credential.token)).id,
    principal.id,
  );
  await c.tokens.revoke(principal, credential.id);
  await assert.rejects(
    c.identity.authenticate(credential.token),
    /INVALID_TOKEN/,
  );
});
test("任务级委托可审批并记录真实操作者，撤销后不能读取或继续审批", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const delegate = { ...principal, id: "reviewer" };
  await c.db.pool.query(
    "INSERT INTO principals(id,workspace_id,token_hash,capabilities) VALUES($1,$2,$3,$4)",
    [
      delegate.id,
      delegate.workspace_id,
      tokenHash("delegate-test"),
      delegate.capabilities,
    ],
  );
  const task = await c.service.create(
    principal,
    "reviewed-report",
    { title: "Review", values: [1, 2] },
    "delegated",
  );
  await drain(c);
  const grant = await c.delegations.grant(
    principal,
    task.id,
    delegate.id,
    ["read", "approve"],
    1,
    "pair review",
  );
  const detail = await c.service.delegatedDetail(delegate, task.id);
  const wait = detail.waits[0]!;
  await c.service.delegatedApprove(
    delegate,
    task.id,
    wait.id,
    { approved: true },
    "decision",
  );
  assert.equal(
    (
      await c.db.pool.query("SELECT consumed_by FROM waits WHERE id=$1", [
        wait.id,
      ])
    ).rows[0].consumed_by,
    delegate.id,
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  await c.delegations.revoke(principal, grant.id);
  await assert.rejects(
    c.service.delegatedDetail(delegate, task.id),
    /DELEGATION_FORBIDDEN/,
  );
});
test("父子任务持久扇出/聚合不重复创建，预算收窄并传播取消", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const group: Module = {
    id: "batch",
    version: "1",
    title: "batch",
    description: "fixture",
    capability: "report:run",
    input: z.object({}),
    example: {},
    tools: [],
    runtime: { model: false },
    next: (_input, steps) =>
      steps.length
        ? { kind: "complete", result: steps[0]!.output }
        : {
            kind: "children",
            key: "reports",
            children: [1, 2].map((n) => ({
              moduleId: "report",
              input: { title: "batch", values: [n] },
            })),
          },
  };
  c.registry.register(group);
  const task = await c.service.create(principal, "batch", {}, "batch");
  await drain(c);
  await c.groups.tick();
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  const children = await c.tasks.children(task.id);
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.budget.maxCostUsd <= 0.5));
  const output = (await c.service.detail(principal, task.id)).steps[0]!.output;
  assert.ok(Array.isArray(output));
  assert.equal(output.length, 2);
  const cancelled = await c.service.create(
    principal,
    "batch",
    {},
    "cancel-batch",
  );
  await c.worker.tick();
  await c.service.cancel(principal, cancelled.id);
  assert.ok(
    (await c.tasks.children(cancelled.id)).every(
      (child) => child.status === "cancelled",
    ),
  );
});
test("模型内容能力不支持时拒绝，流式只有最终结果可提交，记忆删除使旧引用失效", async (t) => {
  const engine: ModelEngine = {
    id: "fixture",
    capabilities: {
      structuredOutput: "validated",
      maxOutputTokens: 10,
      modalities: ["text"],
    },
    next: async () => ({
      text: "ok",
      calls: [],
      costUsd: 0,
      costEstimated: false,
      inputTokens: 1,
      outputTokens: 1,
    }),
    stream: async function* () {
      yield { type: "text", text: "ok" };
      yield {
        type: "result",
        value: await this.next(
          { instructions: "", messages: [], tools: [] },
          [],
          new AbortController().signal,
        ),
      };
    },
  };
  assert.throws(
    () =>
      prepareModelRequest(
        {
          instructions: "",
          messages: [
            {
              role: "user",
              text: "",
              content: [
                { type: "image", mediaType: "image/png", data: "AA==" },
              ],
            },
          ],
          tools: [],
        },
        engine,
        [],
      ),
    /CONTENT_UNSUPPORTED/,
  );
  const deltas: string[] = [];
  assert.equal(
    (
      await invokeModel(
        engine,
        { stream: true, instructions: "", messages: [], tools: [] },
        [],
        new AbortController().signal,
        { principal, taskId: "t" },
        (text) => deltas.push(text),
      )
    ).text,
    "ok",
  );
  assert.deepEqual(deltas, ["ok"]);
  const c = await setup();
  t.after(() => c.close());
  const actor = {
    ...principal,
    capabilities: [...principal.capabilities, "memory:read", "memory:write"],
  };
  await c.db.pool.query(
    "UPDATE principals SET capabilities=capabilities || ARRAY['memory:read','memory:write'] WHERE workspace_id=$1 AND id=$2",
    [actor.workspace_id, actor.id],
  );
  const memory = await c.memories.put(
    actor,
    "preferences",
    "brief",
    1,
    "memory",
  );
  const provider = c.memories.provider(),
    documents = await provider.load(
      { namespace: "preferences" },
      actor,
      new AbortController().signal,
    );
  await provider.authorize(documents, actor, new AbortController().signal);
  await c.memories.remove(actor, memory.id);
  await assert.rejects(
    provider.authorize(documents, actor, new AbortController().signal),
    /MEMORY_REVOKED/,
  );
});
