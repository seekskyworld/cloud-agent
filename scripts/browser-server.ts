import {
  pendingModel,
  pendingModule,
} from "../tests/fixtures/model-pending.js";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** 测试专用服务在独立库运行，进程结束后移除本次创建的库。 */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { registeredCapabilities } from "../apps/modules.js";
import { createContainer } from "../apps/container.js";
import { createApp } from "../apps/api/app.js";
import { tokenHash } from "../packages/persistence/database.js";
const source =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://cloud_agent_test:local-test-only@127.0.0.1:55439/cloud_agent_test";
const url = new URL(source);
if (!url.pathname.includes("_test")) throw new Error("Test database required");
const name = `cloud_agent_test_browser_${randomBytes(8).toString("hex")}`;
const admin = new pg.Pool({ connectionString: source });
await admin.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const filesDirectory = await mkdtemp(join(tmpdir(), "cloud-agent-browser-"));
const container = await createContainer(
  {
    artifactConfig: {
      provider: "local",
      id: "browser-files",
      directory: filesDirectory,
    },
    businesses: [
      {
        id: "starter",
        enabled: true,
        config: {},
        bindings: { output: "browser-files" },
      },
    ],
    DATABASE_URL: url.toString(),
    AUTH_MODE: "none",
    LOCAL_WORKSPACE: "browser",
    LOCAL_PRINCIPAL: "owner",
    HOST: "127.0.0.1",
    PORT: 3197,
    MODEL_MODE: "demo",
    LLM_BASE_URL: "https://example.invalid",
    LLM_MODEL: "fixture",
    LLM_INPUT_PRICE: 1,
    LLM_OUTPUT_PRICE: 4,
    WORKER_CONCURRENCY: 2,
  },
  { engine: pendingModel },
);
container.registry.register(pendingModule);
// 浏览器专用未知回执替身，不执行真实外部写操作。
container.registry.register({
  id: "browser-unknown",
  version: "1",
  title: "回执核实示例",
  description: "browser fixture",
  capability: "report:run",
  input: z.object({}),
  example: {},
  runtime: { model: false },
  tools: [
    {
      name: "browser.unknown",
      version: "1",
      description: "模拟未知回执",
      capability: "report:run",
      effect: "unsafe_write",
      timeoutMs: 1000,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({
        kind: "unknown",
        reconciliationRef: "browser-receipt",
      }),
    },
  ],
  next: (_input, steps) =>
    steps.length
      ? { kind: "complete", result: steps[0]!.output }
      : { kind: "tool", key: "unknown", name: "browser.unknown", input: {} },
});
await container.db.migrate();
await container.db.pool.query(
  "INSERT INTO principals(id,workspace_id,token_hash,capabilities,role) VALUES($1,$2,$3,$4,'superadmin')",
  [
    "owner",
    "browser",
    tokenHash("browser-test-only-token-not-for-deployment"),
    [...registeredCapabilities(container.registry.list())],
  ],
);
// 所有浏览器场景共享一个回环 IP；测试配额容纳整套流程，生产默认仍为 120 次/分钟。
const app = await createApp(container, { rateLimitMax: 1000 });
await app.listen({ host: "127.0.0.1", port: 3197 });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    await container.operations.heartbeat("browser-test");
    await container.operations.loopHeartbeat("browser-test", "maintenance");
    if (!(await container.worker.tick())) await delay(100);
  }
} finally {
  await app.close();
  await container.close();
  await rm(filesDirectory, { recursive: true, force: true });
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
