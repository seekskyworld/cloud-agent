/** 只在自动创建的独立测试库建立容量基线；不读取项目 .env，不访问真实供应商。 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tokenHash } from "../packages/persistence/database.js";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { loadConfig } from "../apps/config.js";
import { createContainer } from "../apps/container.js";
import { DemoEngine } from "../adapters/engine-pi/index.js";
import { registeredCapabilities, createModules } from "../apps/modules.js";
import type { Principal, ModelEngine } from "../packages/contracts/index.js";
const source =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://cloud_agent_test:local-test-only@127.0.0.1:55439/cloud_agent_test";
const url = new URL(source);
if (!url.pathname.includes("_test")) throw new Error("TEST_DATABASE_REQUIRED");
const count = Number(process.env.BENCHMARK_TASKS ?? 120);
if (!Number.isInteger(count) || count < 20 || count > 10000)
  throw new Error("BENCHMARK_COUNT_INVALID");
const workerCount = Number(process.env.BENCHMARK_WORKERS ?? 4);
if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 32)
  throw new Error("BENCHMARK_WORKERS_INVALID");
const workspaceCount = Number(process.env.BENCHMARK_WORKSPACES ?? 2);
if (
  !Number.isInteger(workspaceCount) ||
  workspaceCount < 1 ||
  workspaceCount > 16
)
  throw new Error("BENCHMARK_WORKSPACES_INVALID");
const database = `cloud_agent_test_bench_${randomBytes(6).toString("hex")}`;
const admin = new pg.Pool({ connectionString: source });
await admin.query(`CREATE DATABASE "${database}"`);
url.pathname = `/${database}`;
const demo = new DemoEngine();
const engine: ModelEngine = {
  id: "benchmark-delayed-demo",
  next: async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return demo.next(args[0]);
  },
};
const c = await createContainer(loadConfig({ DATABASE_URL: url.toString() }), {
  engine,
});
try {
  await c.db.migrate();
  const actors: Principal[] = Array.from(
    { length: workspaceCount },
    (_, index) => `workspace-${index}`,
  ).map((workspace) => ({
    id: "owner",
    workspace_id: workspace,
    enabled: true,
    role: "member",
    capabilities: registeredCapabilities(createModules()),
  }));
  for (const actor of actors)
    await c.db.pool.query(
      "INSERT INTO principals(id,workspace_id,capabilities,token_hash) VALUES($1,$2,$3,$4)",
      [
        actor.id,
        actor.workspace_id,
        actor.capabilities,
        tokenHash(`benchmark:${actor.workspace_id}`),
      ],
    );
  const history = await c.service.create(
    actors[0]!,
    "report",
    { title: "history", values: [1] },
    "history-template",
  );
  while (await c.worker.tick()) {
    /* 只生成已完成的历史记录。 */
  }
  await c.db.pool.query(
    `INSERT INTO tasks(id,conversation_id,workspace_id,principal_id,module_id,module_version,input,request_key,request_hash,config_hash,budget,status,created_at,updated_at)
    SELECT gen_random_uuid(),conversation_id,workspace_id,principal_id,module_id,module_version,input,'history-'||n,request_hash,config_hash,budget,'succeeded',now()-interval '30 days',now()-interval '30 days' FROM tasks CROSS JOIN generate_series(1,1000) AS n WHERE id=$1`,
    [history.id],
  );
  await c.db.pool.query(
    "INSERT INTO events(task_id,type,data) SELECT id,'history.fixture','{}' FROM tasks CROSS JOIN generate_series(1,10) WHERE request_key LIKE 'history-%'",
  );
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const actor = actors[index % actors.length]!;
    const task = await c.service.create(
      actor,
      index % 5 === 0 ? "text" : "report",
      index % 5 === 0
        ? { text: "benchmark", instruction: "echo" }
        : { title: "benchmark", values: [1, 2, 3] },
      `bench-${index}`,
    );
    if (index % 10 === 0) await c.service.cancel(actor, task.id);
  }
  const executionStarted = performance.now();
  let maxConnections = 0,
    maxLockWaiters = 0;
  const sample = setInterval(() => {
    void c.db.pool
      .query<{ connections: string; locks: string }>(
        "SELECT count(*)::text AS connections,count(*) FILTER(WHERE wait_event_type='Lock')::text AS locks FROM pg_stat_activity WHERE datname=current_database()",
      )
      .then((result) => {
        maxConnections = Math.max(
          maxConnections,
          Number(result.rows[0]!.connections),
        );
        maxLockWaiters = Math.max(
          maxLockWaiters,
          Number(result.rows[0]!.locks),
        );
      })
      .catch(() => {});
  }, 20);
  try {
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (await c.worker.tick()) {
          /* 排空受控混合负载。 */
        }
      }),
    );
  } finally {
    clearInterval(sample);
  }
  const elapsedMs = performance.now() - started;
  const latency = (
    await c.db.pool.query(
      "SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM updated_at-created_at)*1000) AS p95_ms,percentile_cont(0.99) WITHIN GROUP(ORDER BY extract(epoch FROM updated_at-created_at)*1000) AS p99_ms FROM tasks WHERE status='succeeded' AND request_key LIKE 'bench-%'",
    )
  ).rows[0];
  const states = (
    await c.db.pool.query(
      "SELECT workspace_id,status,count(*)::integer AS count FROM tasks WHERE request_key LIKE 'bench-%' GROUP BY workspace_id,status ORDER BY workspace_id,status",
    )
  ).rows;
  if (states.some((row) => !["succeeded", "cancelled"].includes(row.status)))
    throw new Error("BENCHMARK_INCOMPLETE");
  const queue = (
    await c.db.pool.query(
      "SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM r.started_at-t.created_at)*1000) AS p95_queue_ms FROM tasks t JOIN LATERAL(SELECT started_at FROM runs WHERE task_id=t.id ORDER BY started_at LIMIT 1) r ON true",
    )
  ).rows[0];
  const report = {
    node: process.version,
    tasks: count,
    historicalTasks: 1001,
    historicalEvents: 10010,
    workers: workerCount,
    tenantCount: actors.length,
    modelDelayMs: 30,
    elapsedMs,
    executionMs: performance.now() - executionStarted,
    throughputPerSecond: (count * 1000) / elapsedMs,
    ...latency,
    ...queue,
    maxConnections,
    maxLockWaiters,
    states,
    events: (
      await c.db.pool.query("SELECT count(*)::integer AS count FROM events")
    ).rows[0].count,
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/capacity.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await c.close();
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
