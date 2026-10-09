/** 扩展注册、凭据与适配器的真实边界契约。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  rename,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  ExtensionRegistry,
  defineExtension,
  Resources,
} from "../packages/extensions/registry.js";
import {
  CommonAccount,
  type MailAdapter,
  type MailContext,
} from "../adapters/mail/settings.js";
import { loadMailAccounts } from "../apps/mail-accounts.js";
import { createMailAccount } from "../apps/mail-factory.js";
import { environmentSecrets } from "../adapters/credentials/environment.js";
import { bearer } from "../packages/connections/index.js";
import { LocalArtifacts } from "../adapters/artifacts/local.js";
import { S3Artifacts } from "../adapters/artifacts/s3.js";
import { fileDigest, MAX_FILE_BYTES } from "../packages/artifacts/index.js";
import { diagnose } from "../apps/doctor.js";
import { loadConfig } from "../apps/config.js";
import { verifyMailContract } from "./extension-contracts.js";

test("第三种邮件实现独立声明配置，工厂无需增加供应商品牌分支", async () => {
  const schema = CommonAccount.extend({
    provider: z.literal("fixture"),
    tenant: z.string().min(1),
  }).strict();
  const extension = defineExtension<MailAdapter, MailContext, typeof schema>({
    id: "fixture",
    schema,
    capabilities: ["receive"],
    identity: (c) => ({ key: c.tenant }),
    create: (c) => ({
      remoteId: c.tenant,
      physical: c.tenant,
      identity: [c.tenant],
      provider: {
        async list() {
          return { ids: ["m1"], cursor: null };
        },
        async read(id) {
          return {
            id,
            sender: "user@example.com",
            text: "hello",
            subject: "hello",
            threadId: "t",
            authenticated: true,
            automatic: false,
          };
        },
        async send() {
          return "sent";
        },
      },
    }),
  });
  const registry = new ExtensionRegistry([extension]);
  const raw = {
    id: "custom",
    provider: "fixture",
    tenant: "one",
    address: "agent@example.com",
    workspace: "w",
    bindings: { "user@example.com": "u" },
    credential: "test",
  };
  const config = loadMailAccounts(
    { MAIL_MODE: "accounts", MAIL_ACCOUNTS: JSON.stringify([raw]) },
    registry,
  )[0]!;
  const adapter = await createMailAccount(
    config,
    async () => ({ kind: "api-key", apiKey: "test" }),
    registry,
  );
  assert.equal(adapter.settings.inbox, "one");
  await verifyMailContract(adapter.provider, "m1");
  assert.equal(registry.describe()[0]!.id, "fixture");
  assert.equal(registry.identity("fixture", raw)?.key, "one");
  assert.throws(() => registry.register(extension), /EXTENSION_DUPLICATE/);
  assert.throws(
    () =>
      registry.parse("fixture", {
        ...raw,
        tenant: 123,
        secret: "never-output",
      }),
    (e) => e instanceof Error && e.message === "EXTENSION_CONFIG_INVALID",
  );
  assert.throws(
    () => registry.parse("missing", {}),
    /EXTENSION_NOT_REGISTERED/,
  );
  assert.throws(() =>
    loadMailAccounts(
      {
        MAIL_MODE: "accounts",
        MAIL_ACCOUNTS: JSON.stringify([raw, { ...raw, id: "two" }]),
      },
      registry,
    ),
  );
});
test("资源逆序释放，单项失败继续且重复关闭不重复执行", async () => {
  const resources = new Resources(),
    order: number[] = [];
  resources.add(async () => {
    order.push(1);
  });
  resources.add(async () => {
    order.push(2);
    throw new Error("secret");
  });
  resources.add(async () => {
    order.push(3);
  });
  await assert.rejects(resources.close(), {
    message: "EXTENSION_CLOSE_FAILED",
  });
  await assert.rejects(resources.close());
  assert.deepEqual(order, [3, 2, 1]);
  await new Resources().close();
});
test("私有凭据文件每次读取新 inode，错误与诊断不泄漏秘密", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-secrets-")),
    file = join(dir, "secrets.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ api: { apiKey: "first" }, bad: 9 }),
      { mode: 0o600 },
    );
    const secrets = environmentSecrets({ file });
    assert.equal(bearer(await secrets("api")), "first");
    await writeFile(
      join(dir, "next"),
      JSON.stringify({ api: { apiKey: "second" } }),
      { mode: 0o600 },
    );
    await rename(join(dir, "next"), file);
    assert.equal(bearer(await secrets("api")), "second");
    await assert.rejects(secrets("bad"), { code: "CREDENTIAL_UNAVAILABLE" });
    await chmod(file, 0o644);
    await assert.rejects(secrets("api"), { code: "CREDENTIAL_UNAVAILABLE" });
    assert.throws(
      () =>
        bearer({
          kind: "oauth2",
          accessToken: "secret",
          expiresAt: "2000-01-01",
        }),
      { code: "CREDENTIAL_EXPIRED" },
    );
    assert.throws(() => bearer({ apiKey: "bad\r\nvalue" }), {
      code: "CREDENTIAL_INVALID",
    });
    assert.equal(
      bearer({
        kind: "oauth2",
        accessToken: "access",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      "access",
    );
    const config = loadConfig({
      DATABASE_URL: "postgres://not-used/db",
      CONNECTIONS: JSON.stringify([
        {
          id: "api",
          endpoint: "https://example.invalid",
          credential: "api",
          grants: [{ workspace: "w", principals: ["u"], capability: "use" }],
        },
      ]),
      CONNECTION_CREDENTIALS_FILE: file,
    });
    const report = await diagnose(config);
    assert.equal(report.ok, false);
    assert.ok(!JSON.stringify(report).includes(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("本地文件不可覆盖、限制路径/大小、拒绝符号链接", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-files-")),
    store = new LocalArtifacts(dir),
    signal = AbortSignal.timeout(5000),
    data = Buffer.from("中文文件");
  const key = fileDigest(data);
  try {
    await Promise.all([
      store.put(key, data, signal),
      store.put(key, data, signal),
    ]);
    assert.deepEqual(await store.get(key, signal), data);
    await assert.rejects(store.put(key, Buffer.from("changed"), signal), {
      code: "ARTIFACT_CONTENT_CHANGED",
    });
    await assert.rejects(store.get("../secrets", signal), {
      code: "ARTIFACT_KEY_INVALID",
    });
    await assert.rejects(
      store.put(
        fileDigest(Buffer.from("large")),
        Buffer.alloc(MAX_FILE_BYTES + 1),
        signal,
      ),
      { code: "ARTIFACT_TOO_LARGE" },
    );
    const link = fileDigest(Buffer.from("link"));
    await symlink(join(dir, key), join(dir, link));
    await assert.rejects(store.get(link, signal));
    await store.remove(key, signal);
    await store.remove(key, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("S3 适配器通过本地 HTTP 协议验证条件写、读取、冲突和删除", async () => {
  const objects = new Map<string, Buffer>();
  let conditional = false;
  const server = createServer(async (req, res) => {
    const key = req.url!.split("?")[0]!;
    if (req.method === "PUT") {
      conditional = req.headers["if-none-match"] === "*";
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      if (objects.has(key)) {
        res.writeHead(412, { "content-type": "application/xml" });
        res.end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      objects.set(key, Buffer.concat(parts));
      res.writeHead(200);
      res.end();
    } else if (req.method === "GET") {
      res.writeHead(200);
      res.end(objects.get(key));
    } else {
      objects.delete(key);
      res.writeHead(204);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = new S3Artifacts(
      new S3Client({
        endpoint: `http://127.0.0.1:${address.port}`,
        region: "local",
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      }),
      "test",
      "s3-test",
    ),
    signal = AbortSignal.timeout(5000),
    data = Buffer.from("s3 body"),
    key = fileDigest(data);
  try {
    await store.put(key, data, signal);
    assert.equal(conditional, true);
    assert.deepEqual(await store.get(key, signal), data);
    await store.put(key, data, signal);
    await assert.rejects(store.put(key, Buffer.from("other"), signal), {
      code: "ARTIFACT_CONTENT_CHANGED",
    });
    await store.remove(key, signal);
    assert.equal(objects.size, 0);
  } finally {
    await store.close();
    server.close();
    await once(server, "close");
  }
});

test("Compose 空邮件变量复用共用凭据，显式邮件 JSON 不被共用文件覆盖", async () => {
  const { createMailCredentials } = await import("../apps/mail-credentials.js");
  const shared = JSON.stringify({ key: { kind: "api-key", apiKey: "shared" } });
  assert.deepEqual(
    await createMailCredentials({
      MAIL_CREDENTIALS: "",
      MAIL_CREDENTIALS_FILE: "",
      CONNECTION_CREDENTIALS: shared,
    })("key"),
    { kind: "api-key", apiKey: "shared" },
  );
  assert.deepEqual(
    await createMailCredentials({
      MAIL_CREDENTIALS: shared,
      CONNECTION_CREDENTIALS_FILE: "/does-not-exist",
    })("key"),
    { kind: "api-key", apiKey: "shared" },
  );
});

test("命名 Pi 配置使用授权连接实际调用协议，密钥轮换不改指纹", async () => {
  const { PiEngine } = await import("../adapters/engine-pi/index.js");
  const { createModelProfiles, loadModelProfiles } =
    await import("../apps/models.js");
  const { Connections } = await import("../packages/connections/index.js");
  const { principal } = await import("./helpers.js");
  const observed: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    observed.push(String(req.headers.authorization));
    res.setHeader("content-type", "text/event-stream");
    const part = {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    };
    res.end(
      `data: ${JSON.stringify(part)}\n\ndata: ${JSON.stringify({ ...part, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let key = "first";
  const connections = new Connections(
    [
      {
        id: "llm",
        endpoint: `http://127.0.0.1:${address.port}`,
        credential: "key",
        grants: [
          {
            workspace: principal.workspace_id,
            principals: [principal.id],
            capability: "text:run",
          },
        ],
      },
    ],
    async () => ({ apiKey: key }),
    async (w, id) => ({ ...principal, workspace_id: w, id }),
  );
  const config = loadModelProfiles(
      JSON.stringify([
        {
          id: "fast",
          provider: "pi",
          connection: "llm",
          model: "fixture",
          inputPrice: 1,
          outputPrice: 4,
        },
      ]),
    ),
    resources = new Resources();
  try {
    const first = (
        await createModelProfiles(config, connections, resources)
      )[0]!,
      request = {
        instructions: "reply",
        messages: [{ role: "user" as const, text: "hi" }],
        tools: [],
      },
      signal = AbortSignal.timeout(5000);
    assert.ok(first.engine.id.startsWith(`${PiEngine.compatibility}:`));
    await assert.rejects(first.engine.next(request, [], signal), {
      code: "MODEL_CONTEXT_REQUIRED",
    });
    assert.equal(
      (
        await first.engine.next(request, [], signal, {
          principal,
          taskId: "fixture",
        })
      ).text,
      "ok",
    );
    key = "second";
    const second = (
      await createModelProfiles(config, connections, resources)
    )[0]!;
    assert.equal(second.fingerprint, first.fingerprint);
    await second.engine.next(request, [], signal, {
      principal,
      taskId: "fixture",
    });
    assert.deepEqual(observed, ["Bearer first", "Bearer second"]);
    await assert.rejects(
      first.engine.next(request, [], signal, {
        principal: { ...principal, workspace_id: "other" },
        taskId: "fixture",
      }),
      { code: "CONNECTION_FORBIDDEN" },
    );
    assert.ok(!first.fingerprint.includes(key));
  } finally {
    await resources.close();
    server.close();
    await once(server, "close");
  }
});

test("离线诊断覆盖附加存储的凭据，失败不输出凭据或路径", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://not-used/db",
    ARTIFACT_STORES: JSON.stringify([
      { provider: "local", id: "local-extra", directory: "/private/test-only" },
      {
        provider: "s3",
        id: "remote-extra",
        region: "test",
        bucket: "fixture",
        credential: "missing",
      },
    ]),
  });
  const report = await diagnose(config);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.map(({ component, status }) => ({ component, status })),
    [
      { component: "artifacts:local-extra", status: "passed" },
      { component: "artifacts:remote-extra", status: "failed" },
    ],
  );
  assert.ok(!JSON.stringify(report).includes("/private/test-only"));
  assert.equal(
    (
      await diagnose({
        ...config,
        secrets: async () => ({
          accessKeyId: "fixture",
          secretAccessKey: "fixture",
        }),
      })
    ).ok,
    true,
  );
});
