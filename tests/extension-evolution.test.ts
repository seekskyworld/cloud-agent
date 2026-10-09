import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ResourceInventory } from "../packages/extensions/inventory.js";
import { configuredResources } from "../apps/resource-inventory.js";
import { diagnose } from "../apps/doctor.js";
import { loadConfig } from "../apps/config.js";
import { createContainer } from "../apps/container.js";
import {
  canReceive,
  canSend,
  type MailTransport,
} from "../packages/mail/contracts.js";
import {
  verifyMailContract,
  verifyMailSendContract,
} from "../packages/testing/index.js";
import { defineBusinessPackage } from "../packages/business/index.js";
import { BusinessApplications } from "../packages/business/application.js";
import { ModelLifecycle } from "../packages/runtime/model-lifecycle.js";
import type { ModelLedger } from "../packages/runtime/model-ledger.js";
import {
  defineBusinessViews,
  validateBusinessViews,
} from "../packages/ui/index.js";
import { setup, principal, drain } from "./helpers.js";

const sender: MailTransport = {
  mode: "send",
  async send(delivery) {
    return delivery.id;
  },
};
const settings = {
  id: "outbound",
  inbox: "outbound",
  address: "sender@example.test",
  workspace: principal.workspace_id,
  bindings: { "owner@example.test": principal.id },
  sendEnabled: true,
  pollMs: 5000,
};
const offline = () => loadConfig({ DATABASE_URL: "postgres://unused/unused" });

test("资源计划覆盖所有注入并校验依赖环和能力，返回值不能篡改", () => {
  const entries = [
    {
      kind: "port" as const,
      id: "a",
      roles: ["api" as const],
      dependencies: ["port:b"],
    },
    {
      kind: "port" as const,
      id: "b",
      roles: ["api" as const],
      dependencies: ["port:a"],
    },
  ];
  assert.throws(() => new ResourceInventory(entries), /DEPENDENCY_CYCLE/);
  assert.throws(
    () => new ResourceInventory([entries[0]!]),
    /DEPENDENCY_MISSING/,
  );
  const plan = configuredResources(offline(), {
    mails: [{ settings, provider: sender }],
    ports: {
      store: {
        token: "store",
        version: 1,
        identity: "v1",
        value: {},
        capabilities: ["query"],
      },
    },
  });
  assert.deepEqual(plan.require("mail", "outbound", ["send"]).capabilities, [
    "send",
  ]);
  assert.throws(
    () => plan.require("mail", "outbound", ["receive"]),
    /CAPABILITY_MISSING/,
  );
  assert.equal(plan.require("port", "store").ownership, "caller");
  assert.throws(() => {
    (plan.require("port", "store").roles as string[]).push("worker");
  }, TypeError);
});

test("诊断使用注入业务目录，不调用工厂或凭据，不把注入当作探测成功", async () => {
  let called = 0;
  const business = defineBusinessPackage({
    id: "external",
    version: "1.0.0",
    sdkMajor: 1,
    permissions: [],
    config: z.object({}),
    requires: { outbox: { kind: "mail", capabilities: ["send"] } },
    create: () => ({ modules: [] }),
  });
  const config = {
    ...offline(),
    businesses: [
      {
        id: "external",
        enabled: true,
        config: {},
        bindings: { outbox: "outbound" },
      },
    ],
    secrets: async () => {
      called++;
      throw Error("not allowed");
    },
  };
  const report = await diagnose(
    config,
    { businesses: [business], mails: [{ settings, provider: sender }] },
    "configuration",
  );
  assert.equal(called, 0);
  assert.equal(
    report.checks.find((c) => c.component === "business:external")?.status,
    "passed",
  );
  assert.equal(
    report.checks.find((c) => c.component === "mail:outbound")?.status,
    "unchecked",
  );
  const factory = await diagnose(
    config,
    {
      businesses: [business],
      factoryResources: [
        {
          kind: "mail",
          id: "outbound",
          roles: ["api", "worker"],
          capabilities: ["send"],
          ownership: "host",
        },
      ],
      mailFactory: () => {
        called++;
        return [];
      },
    },
    "configuration",
  );
  assert.equal(called, 0);
  assert.ok(factory.resources.some((r) => r.id === "outbound"));
});

test("单向邮件无需伪造收信方法，收信账户拒绝启用发送", async (t) => {
  assert.equal(canSend(sender), true);
  assert.equal(canReceive(sender), false);
  await assert.rejects(
    verifyMailContract(sender, "m1"),
    /MAIL_RECEIVE_UNSUPPORTED/,
  );
  assert.equal(
    await verifyMailSendContract(sender, {
      id: "fixture",
      recipient: "a@example.test",
      subject: "test",
      body: "test",
      replyTo: "test",
    }),
    "fixture",
  );
  const base = await setup();
  t.after(() => base.close());
  const c = await createContainer(base.config, {
    mails: [{ settings, provider: sender }],
  });
  t.after(() => c.close());
  await c.mail!.receiveTick();
  assert.equal(
    (await c.db.pool.query("SELECT 1 FROM mailboxes WHERE id='outbound'"))
      .rowCount,
    0,
  );
  await c.mail!.sendTick();
  assert.equal(
    (await c.db.pool.query("SELECT 1 FROM mailboxes WHERE id='outbound'"))
      .rowCount,
    1,
  );
  assert.throws(
    () => c.mail!.verifyWebhook(new Uint8Array(), {}),
    /WEBHOOK_DISABLED/,
  );
  await assert.rejects(
    createContainer(base.config, {
      mails: [
        {
          settings,
          provider: {
            mode: "receive",
            list: async () => ({ ids: [], cursor: null }),
            read: async () => {
              throw Error("unused");
            },
          },
        },
      ],
    }),
    /SEND_UNSUPPORTED/,
  );
});

test("工厂声明与产物失配释放宿主资源，API 角色禁止创建执行器", async () => {
  let closed = 0;
  await assert.rejects(
    createContainer(offline(), {
      factoryResources: [{ kind: "port", id: "expected", roles: ["worker"] }],
      portFactory: (ctx) => {
        ctx.resources.add(async () => {
          closed++;
        });
        return {};
      },
    }),
    /FACTORY_RESOURCE_MISMATCH/,
  );
  assert.equal(closed, 1);
  const c = await createContainer(offline(), { role: "api" });
  try {
    assert.throws(() => c.worker, /WORKER_ROLE_REQUIRED/);
  } finally {
    await c.close();
  }
});

test("模型恢复协调器仅依赖账本协议，不需要数据库或存储类", async () => {
  let pruned = false;
  const store: ModelLedger = {
    begin: async () => {
      throw Error("not invoked");
    },
    uncertain: async () => {},
    receipt: async () => true,
    pending: async () => [],
    prune: async () => {
      pruned = true;
    },
  };
  await new ModelLifecycle(store).reconcile(() => undefined);
  assert.equal(pruned, true);
});

test("排空拒绝新任务和重试，旧幂等请求可读且在途任务可以完成", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const task = await c.service.create(
    principal,
    "report",
    { title: "drain", values: [1] },
    "drain",
  );
  assert.equal(
    await c.deployments.drain("report", true, 0, "test", "retire module"),
    1,
  );
  await assert.rejects(
    c.service.create(
      principal,
      "report",
      { title: "new", values: [2] },
      "drain-new",
    ),
    /MODULE_DRAINING/,
  );
  assert.equal(
    (
      await c.service.create(
        principal,
        "report",
        { title: "drain", values: [1] },
        "drain",
      )
    ).id,
    task.id,
  );
  assert.equal(
    (await c.deployments.impact({ protocol: 1, modules: [], defaults: {} }))
      .safe,
    false,
  );
  await drain(c);
  assert.equal((await c.tasks.get(principal, task.id)).status, "succeeded");
  assert.equal(
    (await c.deployments.impact({ protocol: 1, modules: [], defaults: {} }))
      .safe,
    true,
  );
  await c.db.pool.query("UPDATE tasks SET status='failed' WHERE id=$1", [
    task.id,
  ]);
  await assert.rejects(c.service.retry(principal, task.id), /MODULE_DRAINING/);
  await assert.rejects(
    c.deployments.drain("report", false, 0, "test", "stale"),
    /VERSION_CONFLICT/,
  );
  await c.deployments.drain("report", false, 1, "test", "resume");
  assert.deepEqual(await c.deployments.drains(), [
    { module_id: "report", draining: false, generation: 2 },
  ]);
  await c.service.retry(principal, task.id);
});

test("业务数据生命周期和前端声明缺失不能被静默忽略", () => {
  const applications = new BusinessApplications();
  assert.throws(
    () =>
      applications.add("fixture", [], {
        modules: [],
        dataResources: [
          {
            id: "records",
            kind: "sql",
            backup: "host",
            retention: "business",
            recoveryCheck: "recover",
            retirementCheck: "retire",
          },
        ],
      }),
    /LIFECYCLE_CHECK_REQUIRED/,
  );
  applications.add("fixture", [], {
    modules: [],
    dataResources: [
      {
        id: "records",
        kind: "sql",
        backup: "host",
        retention: "business",
        recoveryCheck: "recover",
        retirementCheck: "retire",
      },
    ],
    checks: [
      {
        id: "recover",
        phase: "recovery",
        run: async () => ({ status: "passed", code: "OK" }),
      },
      {
        id: "retire",
        phase: "retirement",
        run: async () => ({ status: "passed", code: "OK" }),
      },
    ],
  });
  assert.throws(
    () =>
      validateBusinessViews([{ id: "fixture", pages: [{ id: "home" }] }], {}),
    /BUSINESS_VIEW_MISSING/,
  );
  validateBusinessViews([{ id: "headless" }], {});
  validateBusinessViews(
    [{ id: "fixture", pages: [{ id: "home" }] }],
    defineBusinessViews([
      {
        packageId: "fixture",
        pageId: "home",
        sdkMajor: 1,
        Component: () => null,
      },
    ]),
  );
});

test("退出影响检查保留终态任务的未知副作用和未完成渠道投递", async (t) => {
  const c = await setup();
  t.after(() => c.close());
  const task = await c.service.create(
    principal,
    "report",
    { title: "retirement", values: [1] },
    "retirement",
  );
  await drain(c);
  const empty = { protocol: 1 as const, modules: [], defaults: {} };
  assert.equal((await c.deployments.impact(empty)).safe, true);
  await c.db.pool.query(
    "UPDATE tool_invocations SET status='unknown' WHERE task_id=$1",
    [task.id],
  );
  assert.equal((await c.deployments.impact(empty)).safe, false);
  await c.db.pool.query(
    "UPDATE tool_invocations SET status='succeeded' WHERE task_id=$1",
    [task.id],
  );
  await c.db.pool.query(
    "INSERT INTO channel_accounts(id,workspace_id,config_hash) VALUES('retire-channel',$1,'fixture')",
    [principal.workspace_id],
  );
  await c.db.pool.query(
    "INSERT INTO channel_outbox(id,account,task_id,notice_key,subject,principal_id,payload,state) VALUES(gen_random_uuid(),'retire-channel',$1,'done','fixture',$2,'{}','uncertain')",
    [task.id, principal.id],
  );
  assert.equal((await c.deployments.impact(empty)).safe, false);
  await c.db.pool.query(
    "UPDATE channel_outbox SET state='cancelled' WHERE task_id=$1",
    [task.id],
  );
  assert.equal((await c.deployments.impact(empty)).safe, true);
});

test("启动在创建业务前拒绝供应商能力或工厂端口协议失配", async () => {
  let created = false;
  const business = defineBusinessPackage({
    id: "requires-inbound",
    version: "1.0.0",
    sdkMajor: 1,
    permissions: [],
    config: z.object({}),
    requires: { inbox: { kind: "mail", capabilities: ["receive"] } },
    create: () => {
      created = true;
      return { modules: [] };
    },
  });
  await assert.rejects(
    createContainer(
      {
        ...offline(),
        businesses: [
          {
            id: business.id,
            enabled: true,
            config: {},
            bindings: { inbox: "outbound" },
          },
        ],
      },
      { businesses: [business], mails: [{ settings, provider: sender }] },
    ),
    /CAPABILITY_MISSING/,
  );
  assert.equal(created, false);
  await assert.rejects(
    createContainer(offline(), {
      factoryResources: [
        {
          kind: "port",
          id: "store",
          roles: ["api"],
          protocol: { id: "store", version: 2 },
        },
      ],
      portFactory: () => ({
        store: { token: "store", version: 1, identity: "store-v1", value: {} },
      }),
    }),
    /PORT_INCOMPATIBLE/,
  );
});
