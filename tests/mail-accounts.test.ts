/** 多账户隔离、恢复与凭据边界使用真实数据库；供应商调用仅使用内存替身。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, principal, token, otherToken, drain } from "./helpers.js";
import { MailChannel } from "../packages/mail/channel.js";
import { MailStore } from "../packages/mail/store.js";
import { MailHub } from "../packages/mail/hub.js";
import type {
  MailProvider,
  MailSettings,
  MailMessage,
} from "../packages/mail/contracts.js";
import { Problem } from "../packages/contracts/index.js";
import { loadMailAccounts } from "../apps/mail-accounts.js";
import { createMailCredentials } from "../apps/mail-credentials.js";
import { loadMailConfig } from "../apps/mail-config.js";
import { createMailAccount } from "../apps/mail-factory.js";
import { createApp } from "../apps/api/app.js";
import { registerAccountWebhook } from "../scripts/mail-registration.js";
const configuration = (id = "one") => ({
  id,
  provider: "agentmail",
  address: `${id}@example.test`,
  workspace: "workspace-a",
  bindings: { "user@example.test": "owner" },
  credential: id,
  inbox: `${id}@example.test`,
});
const settings = (id: string, workspace = "workspace-a"): MailSettings => ({
  id,
  provider: "fixture",
  inbox: `${id}@example.test`,
  workspace,
  bindings: { "user@example.test": "owner" },
  sendEnabled: true,
  pollMs: 1000,
});
const message = (id = "same"): MailMessage => ({
  id,
  threadId: "same-thread",
  sender: "user@example.test",
  authenticated: true,
  automatic: false,
  subject: "fixture",
  text: "hello",
});
function provider(): MailProvider {
  return {
    list: async () => ({ ids: [], cursor: null }),
    read: async (id) => message(id),
    send: async (delivery) => `<${delivery.id}@example.test>`,
  };
}
function channel(
  c: Awaited<ReturnType<typeof setup>>,
  id: string,
  workspace?: string,
  p = provider(),
) {
  return new MailChannel(
    new MailStore(c.db, settings(id, workspace)),
    p,
    c.identity,
    c.service,
  );
}
async function receive(mail: MailChannel, id = "same") {
  await mail.store.receive({ id, messageId: id, digest: id });
  await mail.receiveTick();
}

test("账户/工作区隔离消息幂等与回复关联，同供应商 ID 不会串任务", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const a = channel(c, "a"),
    b = channel(c, "b"),
    other = channel(c, "other", "workspace-b");
  await Promise.all([receive(a), receive(b), receive(other)]);
  await receive(a);
  const tasks = (await c.db.pool.query("SELECT * FROM tasks")).rows;
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map((row) => row.conversation_id)).size, 3);
  await drain(c);
  await a.notifyTick();
  await a.sendTick();
  const out = (
    await c.db.pool.query("SELECT * FROM mail_outbox WHERE mailbox='a'")
  ).rows[0];
  assert.ok(
    await a.store.linkedReply(
      { ...message(), inReplyTo: out.provider_id },
      principal,
    ),
  );
  assert.equal(
    await b.store.linkedReply(
      { ...message(), inReplyTo: out.provider_id },
      principal,
    ),
    undefined,
  );
  await assert.rejects(
    new MailStore(c.db, {
      ...settings("a"),
      inbox: "changed@example.test",
    }).initialize(),
    /MAIL_ACCOUNT_CHANGED/,
  );
  await assert.rejects(
    new MailStore(c.db, settings("a", "workspace-b")).initialize(),
    /MAIL_ACCOUNT_CHANGED/,
  );
  await assert.rejects(
    new MailStore(c.db, { ...settings("a"), provider: "other" }).initialize(),
    /MAIL_ACCOUNT_CHANGED/,
  );
});

test("慢收取不阻止另一账户及发送，循环异常独立记录且最多两个账户并发", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const slow = channel(c, "slow", "workspace-a", {
    ...provider(),
    list: async () => {
      entered();
      await held;
      return { ids: [], cursor: null };
    },
  });
  const fast = channel(c, "fast");
  await receive(fast);
  await drain(c);
  await fast.notifyTick();
  const hub = new MailHub([slow, fast]);
  const scanning = hub.tick("receive");
  await started;
  try {
    await hub.tick("send");
    assert.equal((await fast.store.status()).outbox[0].state, "sent");
  } finally {
    release();
    await scanning;
  }
  const channels = Array.from({ length: 5 }, (_, i) =>
    channel(c, `parallel-${i}`),
  );
  let active = 0,
    peak = 0;
  for (const mail of channels)
    mail.receiveTick = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      if (mail.store.id === "parallel-0")
        throw new Problem(409, "MAIL_FIXTURE_FAILURE");
    };
  await new MailHub(channels).tick("receive");
  assert.equal(peak, 2);
  assert.equal(
    (await channels[0]!.store.status()).health[0].error,
    "MAIL_FIXTURE_FAILURE",
  );
  assert.equal((await channels[1]!.store.status()).health[0].error, null);
  assert.throws(() => new MailHub([fast, fast]), /MAIL_ACCOUNT_ID_CONFLICT/);
});

test("多账户管理员只见当前工作区，游标重置与收取互斥并审计，指标不带秘密", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  await c.db.pool.query("UPDATE principals SET role='superadmin'");
  const a = channel(c, "a"),
    b = channel(c, "b", "workspace-b");
  c.mails = [a, b];
  const app = await createApp(c);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  let response = await app.inject({ url: "/v1/admin/mail", headers });
  assert.deepEqual(
    response.json().accounts.map((row: { id: string }) => row.id),
    ["a"],
  );
  response = await app.inject({
    url: "/v1/admin/mail",
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.deepEqual(
    response.json().accounts.map((row: { id: string }) => row.id),
    ["b"],
  );
  const payload = {
    action: "reset-cursor",
    target: "mailbox",
    reason: "audited mailbox replacement",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/mail/b/commands",
        headers,
        payload,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/mail/commands",
        headers,
        payload,
      })
    ).statusCode,
    409,
  );
  const lock = await c.db.pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('mail:a:receive'))");
    response = await app.inject({
      method: "POST",
      url: "/v1/admin/mail/a/commands",
      headers,
      payload,
    });
    assert.equal(response.json().error, "MAIL_ACCOUNT_BUSY");
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('mail:a:receive'))");
    lock.release();
  }
  await c.db.pool.query(
    "UPDATE mailboxes SET cursor='old',blocked_reason='epoch' WHERE id='a'",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/mail/a/commands",
        headers,
        payload,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await c.db.pool.query("SELECT cursor FROM mailboxes WHERE id='a'")).rows[0]
      .cursor,
    null,
  );
  assert.equal(
    (await c.db.pool.query("SELECT action FROM mail_audit")).rows[0].action,
    "reset-cursor",
  );
  await a.store.health("receive", null);
  await b.store.health("receive", "fixture");
  const metrics = await c.operations.metrics("workspace-a");
  assert.match(
    metrics,
    /cloud_agent_mail_account_healthy\{account="a",kind="receive"\} 1/,
  );
  assert.doesNotMatch(metrics, /account="b"|example.test|credential/);
  await c.db.pool.query("UPDATE principals SET role='member'");
  assert.equal(
    (await app.inject({ url: "/v1/admin/mail", headers })).statusCode,
    403,
  );
});

test("配置拒绝重复账户、物理邮箱和含秘密字段，凭据私有文件原子轮换及错误脱敏", async (t) => {
  const base = configuration();
  assert.equal(loadMailAccounts({ MAIL_MODE: "disabled" }).length, 0);
  assert.equal(
    loadMailAccounts({
      MAIL_MODE: "accounts",
      MAIL_ACCOUNTS: JSON.stringify([base]),
    })[0]!.sendEnabled,
    false,
  );
  for (const accounts of [
    [base, base],
    [base, { ...base, id: "second" }],
    [{ ...base, password: "not-allowed" }],
  ])
    assert.throws(
      () =>
        loadMailAccounts({
          MAIL_MODE: "accounts",
          MAIL_ACCOUNTS: JSON.stringify(accounts),
        }),
      /MAIL_(ACCOUNT|CREDENTIAL_REFERENCE)/,
    );
  const directory = await mkdtemp(join(tmpdir(), "cloud-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "secret.json");
  await writeFile(
    file,
    JSON.stringify({ one: { kind: "password", password: "first" } }),
    { mode: 0o600 },
  );
  const credentials = createMailCredentials({ MAIL_CREDENTIALS_FILE: file });
  assert.deepEqual(await credentials("one"), {
    kind: "password",
    password: "first",
  });
  await writeFile(
    `${file}.new`,
    JSON.stringify({ one: { kind: "password", password: "second" } }),
    { mode: 0o600 },
  );
  await rename(`${file}.new`, file);
  assert.deepEqual(await credentials("one"), {
    kind: "password",
    password: "second",
  });
  await chmod(file, 0o644);
  await assert.rejects(credentials("one"), /MAIL_CREDENTIAL_UNAVAILABLE/);
  await rm(file);
  await assert.rejects(
    credentials("one"),
    (error) =>
      error instanceof Error && error.message === "MAIL_CREDENTIAL_UNAVAILABLE",
  );
  await assert.rejects(
    createMailCredentials({
      MAIL_CREDENTIALS: JSON.stringify({
        one: {
          kind: "oauth2",
          accessToken: "expired-secret",
          expiresAt: "2020-01-01T00:00:00Z",
        },
      }),
    })("one"),
    /MAIL_CREDENTIAL_UNAVAILABLE/,
  );
  await assert.rejects(
    createMailCredentials({ MAIL_CREDENTIALS: "secret malformed json" })("one"),
    /MAIL_CREDENTIAL_UNAVAILABLE/,
  );
});

function webhook(inbox: string, key: string) {
  const raw = JSON.stringify({
    type: "event",
    event_type: "message.received",
    event_id: "same-event",
    message: { inbox_id: inbox, message_id: "same" },
  });
  const time = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`same-event.${time}.${raw}`)
    .digest("base64");
  return {
    raw,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture-token-for-webhook-long-enough",
      "svix-id": "same-event",
      "svix-timestamp": time,
      "svix-signature": `v1,${sig}`,
    },
  };
}

test("通用回调按账户验签，轮换密钥立即生效，多账户没有歧义旧路径", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  let key = `whsec_${Buffer.from("fixture-key-that-is-long-enough-1").toString("base64")}`;
  const configs = loadMailAccounts({
    MAIL_MODE: "accounts",
    MAIL_ACCOUNTS: JSON.stringify([configuration("a"), configuration("b")]),
  });
  c.mails = await Promise.all(
    configs.map(async (config) => {
      const options = await createMailAccount(config, async () => ({
        kind: "api-key",
        apiKey: "fixture-only",
        webhookToken: "fixture-token-for-webhook-long-enough",
        webhookSecret: key,
      }));
      return new MailChannel(
        new MailStore(c.db, options.settings),
        options.provider,
        c.identity,
        c.service,
      );
    }),
  );
  const app = await createApp(c);
  t.after(() => app.close());
  const hook = webhook("a@example.test", key);
  const send = (url: string, value = hook) =>
    app.inject({
      method: "POST",
      url,
      headers: value.headers,
      payload: value.raw,
    });
  assert.equal((await send("/hooks/mail/a")).statusCode, 202);
  assert.equal((await send("/hooks/mail/b")).statusCode, 403);
  assert.equal((await send("/hooks/agentmail")).statusCode, 404);
  key = `whsec_${Buffer.from("fixture-key-that-is-long-enough-2").toString("base64")}`;
  assert.equal((await send("/hooks/mail/a")).statusCode, 401);
  assert.equal(
    (await send("/hooks/mail/a", webhook("a@example.test", key))).statusCode,
    202,
  );
});

test("007 旧邮箱记录升级 008 后沿用主键、游标和历史去重", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  await c.db.pool.query(
    "DROP TABLE mail_health; ALTER TABLE mailboxes DROP COLUMN provider,DROP COLUMN remote_id,DROP COLUMN address,DROP COLUMN config_hash; DELETE FROM schema_migrations WHERE name='008_mail_accounts.sql'",
  );
  await c.db.pool.query(
    "INSERT INTO mailboxes(id,workspace_id,cursor) VALUES('legacy@example.test','workspace-a','legacy-cursor'); INSERT INTO mail_inbound(mailbox,message_id) VALUES('legacy@example.test','old')",
  );
  await c.db.migrate();
  const store = new MailStore(c.db, {
    ...settings("ignored"),
    id: undefined,
    provider: undefined,
    inbox: "legacy@example.test",
  });
  await store.initialize();
  const row = (await c.db.pool.query("SELECT * FROM mailboxes")).rows[0];
  assert.equal(row.provider, "agentmail");
  assert.equal(row.remote_id, row.id);
  assert.equal(row.cursor, "legacy-cursor");
  const oldConfig = loadMailConfig({
    MAIL_MODE: "agentmail",
    AGENTMAIL_INBOX: "second@example.test",
    AGENTMAIL_API_KEY: "fixture",
    MAIL_WORKSPACE: "workspace-a",
    MAIL_BINDINGS: '{"user@example.test":"owner"}',
  })!;
  await new MailStore(c.db, oldConfig).initialize();
  const converted = loadMailAccounts({
    MAIL_MODE: "accounts",
    MAIL_ACCOUNTS: JSON.stringify([
      {
        ...configuration(),
        id: oldConfig.inbox,
        inbox: oldConfig.inbox,
        address: oldConfig.inbox,
      },
    ]),
  })[0]!;
  const options = await createMailAccount(converted, async () => ({
    kind: "api-key",
    apiKey: "fixture",
  }));
  await new MailStore(c.db, options.settings).initialize();
  assert.equal(
    (await store.receive({ id: "replayed", messageId: "old", digest: "old" }))
      .duplicate,
    true,
  );
});

test("多账户回调注册保存到指定 credential，重复注册复用而不重复创建", async () => {
  const env = {
    MAIL_MODE: "accounts",
    MAIL_ACCOUNTS: JSON.stringify([configuration()]),
    MAIL_CREDENTIALS: JSON.stringify({
      one: { kind: "api-key", apiKey: "fixture" },
      untouched: { kind: "password", password: "unchanged" },
    }),
  };
  const url = "https://example.test/hooks/mail/one";
  let created = false,
    posts = 0;
  const transport: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      created = true;
      posts++;
      return Response.json({
        webhook_id: "hook-one",
        secret: `whsec_${Buffer.from("fixture-signing-key-long-enough").toString("base64")}`,
      });
    }
    return Response.json({
      webhooks: created
        ? [
            {
              webhook_id: "hook-one",
              url,
              enabled: true,
              event_types: ["message.received"],
            },
          ]
        : [],
    });
  };
  const save = async (values: Record<string, string>) => {
    Object.assign(env, values);
  };
  await registerAccountWebhook(env, "one", url, save, transport);
  await registerAccountWebhook(env, "one", url, save, transport);
  assert.equal(posts, 1);
  assert.equal(
    JSON.parse(env.MAIL_CREDENTIALS).untouched.password,
    "unchanged",
  );
  assert.equal((await createMailCredentials(env)("one")).kind, "api-key");
  await assert.rejects(
    registerAccountWebhook(
      env,
      "one",
      "https://example.test/hooks/mail/wrong",
      save,
      transport,
    ),
    /MAIL_CALLBACK_URL_INVALID/,
  );
});
