/** 受控传输验证供应商协议、MIME 和凭据隔离；不使用真实邮箱或密钥。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AgentMail } from "../adapters/agentmail/client.js";
import { verifyWebhook } from "../adapters/agentmail/webhook.js";
import { loadMailConfig } from "../apps/mail-config.js";
const signal = () => AbortSignal.timeout(5000);

test("Webhook 接受普通字节视图且保留签名范围，兼容 Buffer", () => {
  const secret = Buffer.from("fixture-signing-key-with-32-bytes!");
  const settings = {
    inbox: "agent@example.test",
    workspace: "fixture",
    bindings: {},
    sendEnabled: false,
    pollMs: 5000,
    webhookSecret: `whsec_${secret.toString("base64")}`,
    webhookToken: "fixture-token",
  };
  const raw = Buffer.from(
    JSON.stringify({
      event_type: "message.received",
      event_id: "event-中文",
      message: { inbox_id: settings.inbox, message_id: "message" },
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`event.${timestamp}.`)
    .update(raw)
    .digest("base64");
  const headers = {
    authorization: `Bearer ${settings.webhookToken}`,
    "svix-id": "event",
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
  const padded = new Uint8Array(raw.length + 2);
  padded.set(raw, 1);
  const view = padded.subarray(1, -1);
  const expected = verifyWebhook(raw, headers, settings);
  assert.equal(expected.id, "event-中文");
  assert.deepEqual(verifyWebhook(view, headers, settings), expected);
  view[0] = 0;
  assert.throws(
    () => verifyWebhook(view, headers, settings),
    /MAIL_WEBHOOK_SIGNATURE/,
  );
});
const mime =
  "From: User <USER@example.test>\r\nTo: agent@example.test\r\nSubject: Test mail\r\nMessage-ID: <m1@example.test>\r\nIn-Reply-To: <prior@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world";
function fixture() {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const data = {
    size: 100,
    download_url: "https://cdn.agentmail.to/raw",
    dmarc: "pass",
    labels: ["received"],
    raw: mime,
  };
  const transport: typeof fetch = async (url, init) => {
    const address = String(url);
    requests.push({ url: address, init });
    if (address.startsWith("https://cdn.agentmail.to"))
      return new Response(data.raw);
    if (address.endsWith("/raw"))
      return Response.json({
        size: data.size,
        download_url: data.download_url,
      });
    if (init?.method === "POST")
      return Response.json({ message_id: "<sent@example.test>" });
    if (address.includes("?"))
      return Response.json({
        messages: [{ message_id: "m1" }],
        next_page_token: "next",
      });
    return Response.json({
      message_id: "m1",
      thread_id: "t1",
      labels: data.labels,
      authentication_results: { dmarc: data.dmarc },
    });
  };
  return {
    client: new AgentMail(
      "agent@example.test",
      "test-key",
      "https://api.agentmail.to/v0",
      ["cdn.agentmail.to"],
      transport,
    ),
    requests,
    data,
  };
}
test("AgentMail 分页、原件解析和回复头遵循协议，下载不泄露密钥", async () => {
  const f = fixture();
  assert.deepEqual(await f.client.list("old", signal()), {
    ids: ["m1"],
    cursor: "next",
  });
  assert.match(f.requests[0]!.url, /page_token=old/);
  const message = await f.client.read("m1", signal());
  assert.equal(message.sender, "user@example.test");
  assert.equal(message.authenticated, true);
  assert.equal(message.text, "Hello world");
  assert.equal(message.inReplyTo, "<prior@example.test>");
  const download = f.requests.find((r) => r.url.includes("cdn.agentmail.to"))!;
  assert.equal(download.init?.headers, undefined);
  assert.equal(download.init?.redirect, "error");
  assert.equal(
    await f.client.send(
      {
        id: "stable",
        recipient: "user@example.test",
        subject: "reply",
        body: "answer",
        replyTo: "m1",
      },
      signal(),
    ),
    "<sent@example.test>",
  );
  const sent = JSON.parse(f.requests.at(-1)!.init!.body as string);
  assert.deepEqual(sent.to, ["user@example.test"]);
  assert.equal(sent.headers["Auto-Submitted"], "auto-replied");
  assert.equal(sent.headers["Message-ID"], "<stable@cloud-agent.local>");
  assert.equal(sent.cc, undefined);
});
test("未认证元数据和自动回复不会被伪造邮件头掩盖", async () => {
  const f = fixture();
  f.data.dmarc = "fail";
  f.data.raw =
    "Authentication-Results: evil; dmarc=pass\r\nAuto-Submitted: auto-replied\r\n" +
    mime;
  const message = await f.client.read("m1", signal());
  assert.equal(message.authenticated, false);
  assert.equal(message.automatic, true);
  f.data.raw = mime.replace(
    "User <USER@example.test>",
    "a@example.test, b@example.test",
  );
  await assert.rejects(f.client.read("m1", signal()), /MAIL_SENDER_INVALID/);
  f.data.raw = mime.replace("Hello world", "");
  await assert.rejects(f.client.read("m1", signal()), /MAIL_TEXT_INVALID/);
});
test("下载目的地、重定向、实际长度和元数据长度都受限制", async () => {
  const f = fixture();
  for (const url of [
    "http://cdn.agentmail.to/raw",
    "https://evil.test/raw",
    "https://user:pass@cdn.agentmail.to/raw",
    "https://cdn.agentmail.to:8443/raw",
  ]) {
    f.data.download_url = url;
    await assert.rejects(f.client.read("m1", signal()), /MAIL_DOWNLOAD_HOST/);
  }
  f.data.download_url = "https://cdn.agentmail.to/raw";
  f.data.size = 200001;
  await assert.rejects(f.client.read("m1", signal()), /MAIL_TOO_LARGE/);
  f.data.size = 0;
  f.data.raw = "x".repeat(200001);
  await assert.rejects(f.client.read("m1", signal()), /MAIL_TOO_LARGE/);
  f.data.raw = mime;
  f.data.labels = ["received", "spam"];
  await assert.rejects(f.client.read("m1", signal()), /MAIL_NOT_RECEIVED/);
  assert.throws(
    () => new AgentMail("inbox", "key", "http://evil.test"),
    /HTTPS_REQUIRED/,
  );
});
test("AgentMail HTTP 故障和无效响应不被伪装为发送成功", async () => {
  const denied = new AgentMail(
    "inbox",
    "key",
    undefined,
    undefined,
    async () => new Response("private error", { status: 403 }),
  );
  await assert.rejects(denied.list(null, signal()), /MAIL_HTTP_403/);
  const invalid = new AgentMail(
    "inbox",
    "key",
    undefined,
    undefined,
    async () => Response.json({}),
  );
  await assert.rejects(
    invalid.send(
      {
        id: "1",
        recipient: "user@example.test",
        subject: "x",
        body: "x",
        replyTo: "x",
      },
      signal(),
    ),
  );
  const large = new AgentMail(
    "inbox",
    "key",
    undefined,
    undefined,
    async () => new Response("x".repeat(1000001)),
  );
  await assert.rejects(large.list(null, signal()), /MAIL_TOO_LARGE/);
});
test("邮件默认关闭，启用必须提供 Key、邮箱和显式绑定，Webhook 需要独立密钥", () => {
  assert.equal(loadMailConfig({}), undefined);
  assert.throws(
    () => loadMailConfig({ MAIL_MODE: "agentmail" }),
    /KEY_AND_INBOX/,
  );
  const env = {
    MAIL_MODE: "agentmail",
    AGENTMAIL_API_KEY: "fixture",
    AGENTMAIL_INBOX: "agent@example.test",
    MAIL_BINDINGS: '{"User@example.test":"owner"}',
  };
  const config = loadMailConfig(env)!;
  assert.equal(config.bindings["user@example.test"], "owner");
  assert.equal(config.sendEnabled, false);
  assert.equal(config.pollMs, 5000);
  assert.throws(
    () => loadMailConfig({ ...env, MAIL_BINDINGS: "{}" }),
    /MAIL_BINDINGS_REQUIRED/,
  );
  assert.throws(
    () => loadMailConfig({ ...env, MAIL_BINDINGS: "invalid" }),
    /MAIL_BINDINGS_INVALID/,
  );
  assert.throws(
    () => loadMailConfig({ ...env, AGENTMAIL_RECEIVE_MODE: "webhook" }),
    /CREDENTIALS_REQUIRED/,
  );
  assert.throws(
    () =>
      verifyWebhook(
        Buffer.from("{}"),
        {},
        { ...config, webhookSecret: undefined },
      ),
    /MAIL_WEBHOOK_DISABLED/,
  );
});

test("Webhook 注册保存一次性凭据，可重入且结果不明不自动再次 POST", async () => {
  const { registerWebhook } = await import(
    "../adapters/agentmail/registration.js"
  );
  const saved: Record<string, string> = {};
  let posts = 0;
  const hooks: object[] = [];
  const options = {
    baseUrl: "https://api.agentmail.to/v0",
    apiKey: "fixture-key",
    url: "https://agent.example.test/hooks/agentmail",
    saved,
    save: async (values: Record<string, string>) => {
      Object.assign(saved, values);
    },
  };
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method !== "POST") return Response.json({ webhooks: hooks });
    posts++;
    const body = JSON.parse(init.body as string);
    assert.equal(body.inbox_ids, undefined);
    assert.equal(
      body.headers.Authorization,
      `Bearer ${saved.AGENTMAIL_WEBHOOK_TOKEN}`,
    );
    hooks.push({
      webhook_id: "hook1",
      url: options.url,
      enabled: true,
      event_types: ["message.received"],
    });
    return Response.json({
      webhook_id: "hook1",
      secret: `whsec_${Buffer.from("fixture-signing-secret-32-bytes!!").toString("base64")}`,
    });
  };
  await registerWebhook(options, transport);
  assert.equal(posts, 1);
  assert.equal(saved.AGENTMAIL_WEBHOOK_ID, "hook1");
  await registerWebhook(options, transport);
  assert.equal(posts, 1);
  delete saved.AGENTMAIL_WEBHOOK_SECRET;
  await assert.rejects(
    registerWebhook(options, transport),
    /CREDENTIALS_MISSING/,
  );
  assert.equal(posts, 1);
  await assert.rejects(
    registerWebhook(
      { ...options, url: "http://bad.test/hooks/agentmail" },
      transport,
    ),
    /CALLBACK_URL_INVALID/,
  );
});
