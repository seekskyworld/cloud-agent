/** 标准邮箱使用真实 TLS/SMTP 协议与本地 DKIM 密钥验证，没有真实收发。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mailServers, mailSigner } from "./fixtures/mail-servers.js";
import { ImapSmtp } from "../adapters/imap-smtp/index.js";
import { normalizeMime, parseMime } from "../adapters/mail/mime.js";
import { authenticateMime } from "../adapters/mail/authentication.js";
import { setup, principal, drain } from "./helpers.js";
import { MailStore } from "../packages/mail/store.js";
import { MailChannel } from "../packages/mail/channel.js";
const signal = () => AbortSignal.timeout(10_000);

test("IMAP UID 同步、DKIM 来信、真实 Worker 和 SMTP 回复闭环；重投相同 Message-ID 不重复创建", async (t) => {
  const c = await setup();
  t.after(() => c.db.close());
  const servers = await mailServers();
  t.after(() => servers.close());
  const signer = mailSigner();
  const provider = new ImapSmtp(
    servers.options,
    async () => ({ kind: "password", password: "fixture" }),
    { ca: servers.ca, resolver: signer.resolver },
  );
  const source = await signer.sign();
  servers.state.messages.set(1, source);
  const store = new MailStore(c.db, {
    id: "standard",
    provider: "imap-smtp",
    address: servers.options.address,
    inbox: servers.options.address,
    workspace: principal.workspace_id,
    bindings: { "user@example.test": principal.id },
    sendEnabled: true,
    pollMs: 1000,
  });
  const mail = new MailChannel(store, provider, c.identity, c.service);
  await mail.receiveTick();
  await drain(c);
  await mail.notifyTick();
  await mail.sendTick();
  assert.equal(servers.state.sent.length, 1);
  const reply = await parseMime(servers.state.sent[0]!);
  assert.equal(reply.inReplyTo, "<original@example.test>");
  assert.match(reply.text!, /未调用模型/);
  assert.ok(servers.state.commands.includes("EXAMINE"));
  assert.ok(!servers.state.commands.includes("SELECT"));
  servers.state.messages.set(2, source);
  await c.db.pool.query("UPDATE mailboxes SET next_poll=now()");
  await mail.receiveTick();
  assert.equal(
    (await c.db.pool.query("SELECT count(*) FROM tasks")).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await c.db.pool.query(
        "SELECT count(*) FROM mail_inbound WHERE state='processed'",
      )
    ).rows[0].count,
    "2",
  );
  servers.state.validity = 102;
  await c.db.pool.query("UPDATE mailboxes SET next_poll=now()");
  await mail.receiveTick();
  assert.equal(
    (await store.status()).mailbox.blocked_reason,
    "MAIL_UIDVALIDITY_CHANGED",
  );
  await assert.rejects(
    provider.read("101:1", signal()),
    /MAIL_MESSAGE_EPOCH_CHANGED/,
  );
});

test("新邮箱默认跳过旧邮件，分页游标跨连接恢复且删除不改变 UID", async (t) => {
  const servers = await mailServers();
  t.after(() => servers.close());
  const signer = mailSigner();
  const source = await signer.sign();
  for (let uid = 1; uid <= 53; uid++) servers.state.messages.set(uid, source);
  const dependencies = { ca: servers.ca, resolver: signer.resolver },
    credentials = async () => ({
      kind: "password" as const,
      password: "fixture",
    });
  const provider = new ImapSmtp(servers.options, credentials, dependencies);
  const first = await provider.list(null, signal());
  assert.equal(first.ids.length, 50);
  assert.equal(first.hasMore, true);
  servers.state.messages.delete(51);
  const next = await new ImapSmtp(
    servers.options,
    credentials,
    dependencies,
  ).list(first.cursor, signal());
  assert.deepEqual(next.ids, ["101:52", "101:53"]);
  assert.equal(next.hasMore, false);
  const fresh = new ImapSmtp(
    { ...servers.options, imap: { ...servers.options.imap, startFrom: "new" } },
    credentials,
    dependencies,
  );
  const checkpoint = await fresh.list(null, signal());
  assert.equal(checkpoint.ids.length, 0);
  servers.state.messages.set(54, source);
  assert.deepEqual((await fresh.list(checkpoint.cursor, signal())).ids, [
    "101:54",
  ]);
  await assert.rejects(
    provider.list("not json", signal()),
    /MAIL_CURSOR_INVALID/,
  );
});

test("伪造认证头、篡改正文和未签名回复关联不能冒充已认证来信", async () => {
  const signer = mailSigner(),
    source = await signer.sign();
  const valid = normalizeMime(await parseMime(source), "101:1", false);
  assert.equal(
    await authenticateMime(source, valid, signal(), signer.resolver),
    true,
  );
  const changed = Buffer.from(source.toString().replace("hello", "approve"));
  assert.equal(
    await authenticateMime(
      changed,
      normalizeMime(await parseMime(changed), "1", false),
      signal(),
      signer.resolver,
    ),
    false,
  );
  const duplicate = await parseMime(
    Buffer.concat([Buffer.from("Subject: forged\r\n"), source]),
  );
  assert.throws(
    () => normalizeMime(duplicate, "1", false),
    /MAIL_HEADERS_AMBIGUOUS/,
  );
  const unsigned = Buffer.from(
    "Authentication-Results: attacker; dmarc=pass\r\nFrom: user@example.test\r\nSubject: fake\r\nMessage-ID: <fake@example.test>\r\n\r\napprove",
  );
  assert.equal(
    await authenticateMime(
      unsigned,
      normalizeMime(await parseMime(unsigned), "1", false),
      signal(),
      signer.resolver,
    ),
    false,
  );
  const reply = await signer.sign(
    "approve",
    "In-Reply-To: <action@example.test>\r\n",
    ["from", "to", "subject", "message-id"],
  );
  assert.equal(
    await authenticateMime(
      reply,
      normalizeMime(await parseMime(reply), "1", false),
      signal(),
      signer.resolver,
    ),
    false,
  );
});

test("SMTP 明确拒绝与发出后的中断区分，OAuth2 凭据每次重新取得", async (t) => {
  const servers = await mailServers();
  t.after(() => servers.close());
  let token = "token-one";
  const provider = new ImapSmtp(
    servers.options,
    async () => ({
      kind: "oauth2",
      accessToken: token,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    { ca: servers.ca },
  );
  const delivery = {
    id: randomUUID(),
    recipient: "user@example.test",
    subject: "fixture",
    body: "hello",
    replyTo: "<original@example.test>",
  };
  await provider.send(delivery, signal());
  token = "token-two";
  servers.state.reject = 550;
  await assert.rejects(provider.send(delivery, signal()), /MAIL_SMTP_REJECTED/);
  assert.deepEqual(servers.state.auths, ["token-one", "token-two"]);
  servers.state.reject = 0;
  const controller = new AbortController();
  servers.state.onAcceptedData = () => controller.abort();
  await assert.rejects(
    provider.send(delivery, controller.signal),
    /MAIL_CONNECTION_FAILED/,
  );
  servers.state.hold?.();
});

test("STARTTLS 实际升级后发送，IMAP/SMTP 均拒绝不受信任证书", async (t) => {
  const servers = await mailServers("starttls");
  t.after(() => servers.close());
  const credentials = async () => ({
    kind: "password" as const,
    password: "fixture",
  });
  const delivery = {
    id: randomUUID(),
    recipient: "user@example.test",
    subject: "TLS",
    body: "hello",
    replyTo: "<original@example.test>",
  };
  const good = new ImapSmtp(servers.options, credentials, { ca: servers.ca });
  await good.send(delivery, signal());
  assert.equal(servers.state.sent.length, 1);
  const untrusted = new ImapSmtp(servers.options, credentials);
  await assert.rejects(
    untrusted.send(delivery, signal()),
    /MAIL_CONNECTION_FAILED/,
  );
  await assert.rejects(
    untrusted.list(null, signal()),
    /MAIL_CONNECTION_FAILED/,
  );
  assert.equal(servers.state.sent.length, 1);
});
