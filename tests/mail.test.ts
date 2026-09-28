/** 真实 PostgreSQL 验证邮件到任务和回复的恢复边界，供应商替身不发送真实邮件。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setup, drain, principal, token, otherToken } from "./helpers.js";
import { MailChannel } from "../packages/mail/channel.js";
import { MailStore } from "../packages/mail/store.js";
import {
  MailProviderError,
  type MailProvider,
  type MailMessage,
  type MailDelivery,
  type MailSettings,
  type MailRouter,
} from "../packages/mail/contracts.js";
import { verifyWebhook } from "../adapters/agentmail/webhook.js";
import { createApp } from "../apps/api/app.js";
import type { Container } from "../apps/container.js";
import { Problem } from "../packages/contracts/index.js";
class Provider implements MailProvider {
  verifyWebhook?: MailProvider["verifyWebhook"];
  messages = new Map<string, MailMessage>();
  sent: MailDelivery[] = [];
  pages: { ids: string[]; cursor: string | null }[] = [];
  cursors: (string | null)[] = [];
  readError: Error | undefined;
  scanError: Error | undefined;
  sendError: Error | undefined;
  async list(cursor: string | null) {
    this.cursors.push(cursor);
    if (this.scanError) throw this.scanError;
    return this.pages.shift() ?? { ids: [], cursor: null };
  }
  async read(id: string) {
    if (this.readError) throw this.readError;
    const message = this.messages.get(id);
    if (!message) throw new MailProviderError(404);
    return message;
  }
  async send(delivery: MailDelivery) {
    this.sent.push(delivery);
    if (this.sendError) throw this.sendError;
    return `<sent-${delivery.id}@fixture.test>`;
  }
}
const settings = (): MailSettings => ({
  inbox: "agent@example.test",
  workspace: principal.workspace_id,
  bindings: { "user@example.test": "owner" },
  sendEnabled: true,
  pollMs: 5000,
  webhookToken: "fixture-webhook-token-long-enough",
  webhookSecret: `whsec_${Buffer.from("fixture-signing-key-with-32-bytes!").toString("base64")}`,
});
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  route?: MailRouter,
) {
  const c = await setup();
  t.after(() => c.db.close());
  const provider = new Provider(),
    store = new MailStore(c.db, settings());
  const mail = new MailChannel(store, provider, c.identity, c.service, route);
  c.mail = mail;
  c.mails = [mail];
  provider.verifyWebhook = (raw, headers) =>
    verifyWebhook(raw, headers, store.settings);
  await store.initialize();
  return { c, provider, store, mail };
}
async function incoming(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  overrides: Partial<MailMessage> = {},
) {
  f.provider.messages.set(id, {
    id,
    threadId: "thread-1",
    sender: "user@example.test",
    authenticated: true,
    automatic: false,
    subject: "fixture",
    text: "hello",
    ...overrides,
  });
  await f.store.receive({ id: `event-${id}`, messageId: id, digest: id });
}
async function taskRows(c: Container) {
  return (await c.db.pool.query("SELECT * FROM tasks ORDER BY created_at"))
    .rows;
}
async function inbound(c: Container, id: string) {
  return (
    await c.db.pool.query("SELECT * FROM mail_inbound WHERE message_id=$1", [
      id,
    ])
  ).rows[0];
}
async function outbox(c: Container) {
  return (
    await c.db.pool.query("SELECT * FROM mail_outbox ORDER BY created_at")
  ).rows;
}

test("来信经身份映射到真实 Worker 并持久回复，重复推送/轮询与崩溃重放不重复创建", async (t) => {
  const f = await fixture(t);
  await incoming(f, "m1");
  assert.equal(
    (await f.store.receive({ id: "event-m1", messageId: "m1", digest: "m1" }))
      .duplicate,
    true,
  );
  await assert.rejects(
    f.store.receive({ id: "event-m1", messageId: "other", digest: "other" }),
    /MAIL_EVENT_CONFLICT/,
  );
  f.provider.pages.push(
    { ids: ["m1"], cursor: "page2" },
    { ids: ["m1"], cursor: null },
  );
  await Promise.all([f.mail.tick(), f.mail.tick()]);
  assert.equal((await taskRows(f.c)).length, 1);
  // 模拟任务已提交，但消费记录落库前中断。
  await f.c.db.pool.query("UPDATE mail_inbound SET state='pending'");
  await f.c.db.pool.query("UPDATE mailboxes SET next_poll=now()");
  await f.mail.tick();
  assert.deepEqual(f.provider.cursors, [null, "page2"]);
  assert.equal((await taskRows(f.c)).length, 1);
  await drain(f.c);
  await f.mail.tick();
  assert.equal(f.provider.sent.length, 1);
  assert.equal((await outbox(f.c))[0].state, "sent");
  assert.match(f.provider.sent[0]!.body, /未调用模型/);
  await f.mail.tick();
  assert.equal(f.provider.sent.length, 1);
  const status = await f.store.status();
  assert.equal(status.inbound[0].state, "processed");
  assert.ok(!JSON.stringify(status).includes("hello"));
  // 已发送邮件上的追问复用会话，但创建独立任务。
  await incoming(f, "m2", {
    inReplyTo: (await outbox(f.c))[0].provider_id,
    text: "follow-up",
  });
  await f.mail.tick();
  const rows = await taskRows(f.c);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].conversation_id, rows[1].conversation_id);
});

test("邮件补充输入和参数确认通过原等待服务，重复消费不重复执行", async (t) => {
  const f = await fixture(t, () => ({
    moduleId: "reviewed-report",
    input: { values: [2, 4] },
  }));
  await incoming(f, "start");
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  const prompt = (await outbox(f.c))[0];
  assert.equal(prompt.task_status, "waiting_input");
  await incoming(f, "input", {
    inReplyTo: prompt.provider_id,
    text: '{"title":"via mail"}',
  });
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  const approval = (await outbox(f.c)).find(
    (r) => r.task_status === "waiting_approval",
  )!;
  assert.match(approval.body, /2,4/);
  await incoming(f, "approve", {
    inReplyTo: approval.provider_id,
    text: "approve",
  });
  await f.mail.tick();
  await f.c.db.pool.query(
    "UPDATE mail_inbound SET state='pending' WHERE message_id='approve'",
  );
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  assert.equal((await taskRows(f.c))[0].status, "succeeded");
  assert.equal((await taskRows(f.c))[0].result.sum, 6);
  assert.equal(f.provider.sent.length, 3);
});

test("含引用的含糊确认被隔离，明确拒绝不可借来信重放绕过", async (t) => {
  const f = await fixture(t, () => ({
    moduleId: "reviewed-report",
    input: { title: "review", values: [1] },
  }));
  await incoming(f, "start");
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  const prompt = (await outbox(f.c))[0];
  await incoming(f, "ambiguous", {
    inReplyTo: prompt.provider_id,
    text: "approve\n> reject",
  });
  await f.mail.tick();
  assert.equal((await inbound(f.c, "ambiguous")).state, "quarantined");
  await incoming(f, "reject", {
    inReplyTo: prompt.provider_id,
    text: "reject",
  });
  await f.mail.tick();
  assert.equal((await taskRows(f.c))[0].error, "APPROVAL_REJECTED");
  await incoming(f, "late", { inReplyTo: prompt.provider_id, text: "approve" });
  await f.mail.tick();
  assert.equal((await inbound(f.c, "late")).error, "WAIT_CLOSED");
  await f.c.tasks.retry(principal, (await taskRows(f.c))[0].id);
  await drain(f.c);
  assert.equal((await taskRows(f.c))[0].status, "failed");
});

test("未认证、自动回复、未知发件人、自发邮件及已撤权身份不创建任务", async (t) => {
  const f = await fixture(t);
  const variants: Partial<MailMessage>[] = [
    { authenticated: false },
    { automatic: true },
    { sender: "stranger@example.test" },
    { sender: "agent@example.test" },
  ];
  for (let i = 0; i < variants.length; i++)
    await incoming(f, `bad-${i}`, variants[i]);
  await f.mail.tick();
  assert.equal((await taskRows(f.c)).length, 0);
  await f.c.db.pool.query("UPDATE principals SET enabled=false");
  await incoming(f, "disabled");
  await f.mail.tick();
  assert.equal((await inbound(f.c, "disabled")).error, "IDENTITY_REVOKED");
  await f.c.db.pool.query(
    "UPDATE principals SET enabled=true,capabilities='{}'",
  );
  await incoming(f, "no-capability");
  await f.mail.tick();
  assert.equal((await inbound(f.c, "no-capability")).error, "FORBIDDEN");
});

test("发信超时和进程中断持久标为 uncertain，重启不重发，人工核查有审计", async (t) => {
  const f = await fixture(t);
  await incoming(f, "m");
  await f.mail.tick();
  await drain(f.c);
  f.provider.sendError = new Error("network lost");
  await f.mail.tick();
  const row = (await outbox(f.c))[0];
  assert.equal(row.state, "uncertain");
  f.provider.sendError = undefined;
  const recovered = new MailChannel(
    f.store,
    f.provider,
    f.c.identity,
    f.c.service,
  );
  await recovered.tick();
  assert.equal(f.provider.sent.length, 1);
  await f.c.db.pool.query("UPDATE mail_outbox SET state='sending'");
  await f.mail.tick();
  assert.equal((await outbox(f.c))[0].error, "MAIL_INTERRUPTED_SEND");
  await assert.rejects(
    f.store.manage(principal, {
      action: "resolve",
      target: row.id,
      reason: "check",
      resolution: "sent",
      providerId: "verified",
    }),
    /FORBIDDEN/,
  );
  await f.c.db.pool.query("UPDATE principals SET role='superadmin'");
  const admin = { ...principal, role: "superadmin" as const };
  await assert.rejects(
    f.store.manage(admin, {
      action: "resolve",
      target: row.id,
      reason: "check",
      resolution: "sent",
    }),
    /MAIL_RESOLUTION_REQUIRED/,
  );
  await f.store.manage(admin, {
    action: "resolve",
    target: row.id,
    reason: "provider confirmed",
    resolution: "sent",
    providerId: "verified",
  });
  assert.equal((await outbox(f.c))[0].state, "sent");
  assert.equal(
    (await f.c.db.pool.query("SELECT count(*) FROM mail_audit")).rows[0].count,
    "1",
  );
  await assert.rejects(
    f.store.manage(admin, {
      action: "resolve",
      target: row.id,
      reason: "again",
      resolution: "cancelled",
    }),
    /MAIL_STATE_CHANGED/,
  );
});

test("发送前复核身份映射与任务可见性；关闭发送时只存草稿且不补发", async (t) => {
  const f = await fixture(t);
  f.store.settings.sendEnabled = false;
  await incoming(f, "m");
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  assert.equal(f.provider.sent.length, 0);
  assert.equal((await outbox(f.c))[0].state, "draft");
  f.store.settings.sendEnabled = true;
  await f.mail.tick();
  assert.equal(f.provider.sent.length, 0);
  await f.c.db.pool.query("UPDATE mail_outbox SET state='pending'");
  delete f.store.settings.bindings["user@example.test"];
  await f.mail.tick();
  assert.equal((await outbox(f.c))[0].error, "MAIL_BINDING_REVOKED");
});

test("读取和扫描故障退避、耗尽、权限暂停和显式恢复", async (t) => {
  const f = await fixture(t);
  f.provider.scanError = new MailProviderError(400);
  await f.c.db.pool.query("UPDATE mailboxes SET cursor='expired'");
  await f.mail.tick();
  assert.equal(
    (await f.c.db.pool.query("SELECT cursor FROM mailboxes")).rows[0].cursor,
    null,
  );
  f.provider.scanError = undefined;
  await incoming(f, "m");
  f.provider.readError = new Error("temporary");
  await f.mail.tick();
  assert.equal((await inbound(f.c, "m")).state, "pending");
  await f.c.db.pool.query(
    "UPDATE mail_inbound SET attempts=4,next_attempt=now()",
  );
  await f.mail.tick();
  assert.equal((await inbound(f.c, "m")).state, "failed");
  await f.c.db.pool.query("UPDATE principals SET role='superadmin'");
  const admin = { ...principal, role: "superadmin" as const };
  await f.store.manage(admin, {
    action: "retry",
    target: "m",
    reason: "fixed",
  });
  f.provider.readError = new MailProviderError(403);
  await f.mail.tick();
  assert.equal(
    (await f.store.status()).mailbox.blocked_reason,
    "MAIL_HTTP_403",
  );
  const reads = (await inbound(f.c, "m")).attempts;
  await f.mail.tick();
  assert.equal((await inbound(f.c, "m")).attempts, reads);
  f.provider.readError = undefined;
  await f.store.manage(admin, {
    action: "resume",
    target: "mailbox",
    reason: "permission fixed",
  });
  await f.c.db.pool.query("UPDATE mail_inbound SET next_attempt=now()");
  await f.mail.tick();
  assert.equal((await inbound(f.c, "m")).state, "processed");
});

test("Webhook 原字节验签、时间窗、跨邮箱拒绝和 HTTP 管理隔离", async (t) => {
  const f = await fixture(t);
  const app = await createApp(f.c);
  t.after(() => app.close());
  const payload = JSON.stringify({
    event_type: "message.received",
    event_id: "e1",
    message: { inbox_id: f.store.settings.inbox, message_id: "m1" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (raw: string, ts = timestamp) =>
    createHmac(
      "sha256",
      Buffer.from(f.store.settings.webhookSecret!.slice(6), "base64"),
    )
      .update(`svix-1.${ts}.${raw}`)
      .digest("base64");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${f.store.settings.webhookToken}`,
    "svix-id": "svix-1",
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${sign(payload)}`,
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/hooks/agentmail",
        headers,
        payload,
      })
    ).statusCode,
    202,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/hooks/agentmail",
        headers,
        payload: payload + " ",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/hooks/agentmail",
        headers: { ...headers, authorization: "wrong" },
        payload,
      })
    ).statusCode,
    401,
  );
  const wrong = payload.replace(f.store.settings.inbox, "other@example.test");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/hooks/agentmail",
        headers: { ...headers, "svix-signature": `v1,${sign(wrong)}` },
        payload: wrong,
      })
    ).statusCode,
    403,
  );
  const old = String(Number(timestamp) - 600);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/hooks/agentmail",
        headers: {
          ...headers,
          "svix-timestamp": old,
          "svix-signature": `v1,${sign(payload, old)}`,
        },
        payload,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: "/v1/admin/mail",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    403,
  );
  await f.c.db.pool.query("UPDATE principals SET role='superadmin'");
  assert.equal(
    (
      await app.inject({
        url: "/v1/admin/mail",
        headers: { authorization: `Bearer ${otherToken}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: "/v1/admin/mail",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().enabled,
    true,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/mail/commands",
        headers: { authorization: `Bearer ${token}` },
        payload: { action: "resume", target: "mailbox", reason: "test" },
      })
    ).statusCode,
    200,
  );
  const other = new MailStore(f.c.db, {
    ...settings(),
    workspace: "different",
  });
  await assert.rejects(other.initialize(), /MAIL_ACCOUNT_CHANGED/);
});

test("输入回复不合 JSON 时隔离；等待消失后的通知不会发送", async (t) => {
  const f = await fixture(t, () => ({
    moduleId: "report",
    input: { values: [1] },
  }));
  await incoming(f, "m");
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  const row = (await outbox(f.c))[0];
  await incoming(f, "invalid", {
    inReplyTo: row.provider_id,
    text: "not-json",
  });
  await f.mail.tick();
  assert.equal(
    (await inbound(f.c, "invalid")).error,
    "MAIL_INPUT_JSON_REQUIRED",
  );
  await f.c.db.pool.query("UPDATE mail_outbox SET state='pending'");
  await f.c.tasks.cancel(principal, row.task_id);
  await f.mail.tick();
  assert.equal((await outbox(f.c))[0].error, "MAIL_NOTIFICATION_STALE");
});

test("发件服务器明确拒绝不会视为已发送，401/403 暂停邮箱", async (t) => {
  const f = await fixture(t);
  await incoming(f, "m");
  await f.mail.tick();
  await drain(f.c);
  f.provider.sendError = new MailProviderError(403);
  await f.mail.tick();
  assert.equal((await outbox(f.c))[0].state, "failed");
  assert.equal(
    (await f.store.status()).mailbox.blocked_reason,
    "MAIL_HTTP_403",
  );
});

test("结果不可见时通知取消，原始异常不泄露邮件正文", async (t) => {
  const f = await fixture(t);
  await incoming(f, "m");
  await f.mail.tick();
  await drain(f.c);
  f.c.registry.get("text").authorizeRead = async () => {
    throw new Problem(403, "RESOURCE_REVOKED");
  };
  await f.mail.tick();
  assert.equal((await outbox(f.c))[0].error, "RESOURCE_REVOKED");
  assert.equal((await outbox(f.c))[0].body, "");
});

test("其他已绑定成员不能通过回复头消费别人的确认", async (t) => {
  const f = await fixture(t, () => ({
    moduleId: "reviewed-report",
    input: { title: "owner task", values: [1] },
  }));
  await incoming(f, "owner-mail");
  await f.mail.tick();
  await drain(f.c);
  await f.mail.tick();
  const original = (await outbox(f.c))[0];
  await f.c.db.pool.query(
    "INSERT INTO principals(id,workspace_id,token_hash,capabilities) VALUES('other',$1,'unusable-fixture',$2)",
    [principal.workspace_id, principal.capabilities],
  );
  f.store.settings.bindings["other@example.test"] = "other";
  await incoming(f, "foreign", {
    sender: "other@example.test",
    inReplyTo: original.provider_id,
    text: "approve",
  });
  await f.mail.tick();
  assert.equal(
    (await f.c.tasks.get(principal, original.task_id)).status,
    "waiting_approval",
  );
  assert.equal(
    (
      await f.c.db.pool.query("SELECT status FROM waits WHERE id=$1", [
        original.wait_id,
      ])
    ).rows[0].status,
    "pending",
  );
  assert.equal(
    (
      await f.c.db.pool.query("SELECT principal_id FROM tasks WHERE id=$1", [
        (await inbound(f.c, "foreign")).task_id,
      ])
    ).rows[0].principal_id,
    "other",
  );
});

test("慢收取不阻塞发送，不同发送循环互斥且收取不恢复在途发信", async (t) => {
  const f = await fixture(t);
  await incoming(f, "first");
  await f.mail.receiveTick();
  await drain(f.c);
  await f.mail.notifyTick();
  let releaseRead!: () => void, enteredRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const original = f.provider.read.bind(f.provider);
  f.provider.read = async (id) => {
    enteredRead();
    await gate;
    return original(id);
  };
  await incoming(f, "slow");
  const receiving = f.mail.receiveTick();
  await entered;
  let releaseSend!: () => void, enteredSend!: () => void;
  const sendingStarted = new Promise<void>((resolve) => {
    enteredSend = resolve;
  });
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const originalSend = f.provider.send.bind(f.provider);
  f.provider.send = async (delivery) => {
    enteredSend();
    await sendGate;
    return originalSend(delivery);
  };
  const sending = f.mail.sendTick();
  await sendingStarted;
  try {
    assert.equal((await outbox(f.c))[0].state, "sending");
    await f.mail.sendTick(); // 同邮箱第二个发送者不会接管有效发送锁。
    releaseRead();
    await receiving;
    assert.equal((await outbox(f.c))[0].state, "sending");
  } finally {
    releaseRead();
    releaseSend();
    await Promise.all([receiving, sending]);
  }
  assert.equal((await outbox(f.c))[0].state, "sent");
  assert.equal(f.provider.sent.length, 1);
});

test("存在未解决邮件投递的终态任务不归档，sent 后才压缩轨迹", async (t) => {
  const f = await fixture(t);
  await incoming(f, "archive-mail");
  await f.mail.receiveTick();
  await drain(f.c);
  await f.mail.notifyTick();
  const { ArchiveStore } = await import("../packages/persistence/archive.js");
  const store = new ArchiveStore(f.c.db),
    policy = { retentionDays: 30, batchSize: 20, apply: true };
  await f.c.db.pool.query(
    "UPDATE tasks SET updated_at=now()-interval '31 days'",
  );
  for (const state of ["draft", "pending", "sending", "uncertain", "failed"]) {
    await f.c.db.pool.query("UPDATE mail_outbox SET state=$1", [state]);
    assert.equal((await store.run(policy)).archived, 0);
  }
  await f.c.db.pool.query("UPDATE mail_outbox SET state='pending'");
  await f.mail.sendTick();
  assert.equal((await store.run(policy)).archived, 1);
  assert.equal(
    (await f.c.service.events(principal, (await taskRows(f.c))[0].id, "0"))
      .length > 0,
    true,
  );
});
