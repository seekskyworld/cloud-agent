import { ModelRequestStore } from "../packages/persistence/model-requests.js";
import { ExecutionStore } from "../packages/persistence/execution.js";
/** 自动创建两个隔离测试库，真实 pg_dump/psql + 两个对象存储联合恢复；不读取 .env。 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import { createContainer } from "../apps/container.js";
import { loadConfig } from "../apps/config.js";
import { registeredCapabilities } from "../apps/modules.js";
import { Database, tokenHash } from "../packages/persistence/database.js";
import {
  exportBundle,
  restoreObjects,
  verifyBundle,
} from "../packages/recovery/index.js";
import { Deployments } from "../packages/deployment/index.js";
import { ArtifactFiles } from "../packages/artifacts/index.js";
import { LocalArtifacts } from "../adapters/artifacts/local.js";
import type { Principal } from "../packages/contracts/index.js";
const source =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://cloud_agent_test:local-test-only@127.0.0.1:55439/cloud_agent_test";
const url = new URL(source);
if (!url.pathname.includes("_test")) throw new Error("TEST_DATABASE_REQUIRED");
const id = randomBytes(8).toString("hex"),
  names = [`cloud_agent_test_backup_${id}`, `cloud_agent_test_restore_${id}`],
  created: string[] = [];
const admin = new pg.Pool({ connectionString: source }),
  dir = await mkdtemp(join(tmpdir(), "cloud-recovery-"));
const started = performance.now();
try {
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  }
  url.pathname = `/${names[0]}`;
  const c = await createContainer(
    loadConfig({
      DATABASE_URL: url.toString(),
      ARTIFACT_STORES: JSON.stringify(
        ["one", "two"].map((id) => ({
          provider: "local",
          id,
          directory: join(dir, id),
        })),
      ),
    }),
  );
  const restoreUrl = new URL(source);
  restoreUrl.pathname = `/${names[1]}`;
  const target = new Database(restoreUrl.toString());
  try {
    await c.db.migrate();
    const actor: Principal = {
      id: "owner",
      workspace_id: "recovery",
      enabled: true,
      role: "member",
      capabilities: registeredCapabilities(c.registry.list()),
    };
    await c.db.pool.query(
      "INSERT INTO principals(id,workspace_id,token_hash,capabilities) VALUES($1,$2,$3,$4)",
      [
        actor.id,
        actor.workspace_id,
        tokenHash("recovery-drill-local-only"),
        actor.capabilities,
      ],
    );
    const task = await c.service.create(
      actor,
      "report",
      { title: "restore", values: [1, 2] },
      "original-command",
    );
    while (await c.worker.tick()) {
      /* 排空演示任务。 */
    }
    const artifactIds: string[] = [];
    for (const [id, files] of c.stores) {
      const result = await files.put(
        {
          principal: actor,
          taskId: task.id,
          runId: "drill",
          invocationId: id,
          idempotencyKey: id,
          signal: AbortSignal.timeout(5000),
        },
        `${id}.txt`,
        "text/plain",
        Buffer.from(`restored-${id}`),
      );
      artifactIds.push(String(result.id));
    }
    for (const id of artifactIds)
      assert.ok((await c.downloads.get(actor, id)).data.length);
    await assert.rejects(
      c.downloads.get({ ...actor, workspace_id: "other" }, artifactIds[0]!),
      /TASK_NOT_FOUND/,
    );
    const modelTask = await c.service.create(
      actor,
      "text",
      { text: "synthetic recovery", instruction: "echo" },
      "pending-model",
    );
    const lease = await c.execution.claim(c.engine.id);
    assert.equal(lease?.id, modelTask.id);
    const action = c.registry.get("text").next(modelTask.input, []);
    if (action.kind !== "model" || !lease)
      throw new Error("MODEL_FIXTURE_INVALID");
    const step = await c.execution.prepare(lease, action);
    await c.execution.begin(lease, step);
    const modelStore = new ModelRequestStore(c.db);
    const pending = await modelStore.begin(
      lease,
      step,
      c.engine.id,
      { resourceId: c.engine.id },
      Date.now() + 60000,
      "recovery-fixture",
    );
    await modelStore.uncertain(pending.id);
    await modelStore.receipt(pending.id, { state: "unknown" });
    await c.db.pool.query(
      "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [modelTask.id],
    );
    const deployments = new Deployments(c.db),
      revision = await deployments.stage(c.registry.deployment());
    await deployments.activate(revision, null, "test", "restore rehearsal");
    await c.db.pool.query("UPDATE platform_maintenance SET enabled=true");
    const bundle = join(dir, "bundle");
    await exportBundle(c.db, c.stores, bundle, (path) =>
      transfer(names[0]!, path, false),
    );
    await verifyBundle(bundle);
    const dump = await readFile(join(bundle, "database.sql"));
    await writeFile(
      join(bundle, "database.sql"),
      Buffer.concat([dump, Buffer.from("corrupt")]),
    );
    await assert.rejects(verifyBundle(bundle), /DATABASE_CORRUPTED/);
    await writeFile(join(bundle, "database.sql"), dump);
    await transfer(names[1]!, join(bundle, "database.sql"), true);
    for (const id of ["one", "two"])
      await rm(join(dir, id), { recursive: true, force: true });
    const restoredStores = new Map(
      [...c.stores].map(([id]) => [
        id,
        new ArtifactFiles(
          target,
          c.service,
          new LocalArtifacts(join(dir, id), id),
        ),
      ]),
    );
    assert.equal(
      (await restoreObjects(target, restoredStores, bundle)).restored,
      2,
    );
    assert.equal((await new Deployments(target).current())!.id, revision);
    for (const [id, files] of restoredStores) {
      const row = (
        await target.pool.query<{ object_key: string }>(
          "SELECT object_key FROM file_artifacts WHERE store_id=$1",
          [id],
        )
      ).rows[0]!;
      assert.equal(
        (
          await files.store.get(row.object_key, AbortSignal.timeout(5000))
        ).toString(),
        `restored-${id}`,
      );
    }
    const recovered = (
      await target.pool.query(
        "SELECT status,request_key FROM tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0];
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.request_key, "original-command");
    await target.pool.query("UPDATE platform_maintenance SET enabled=false");
    assert.equal(
      (
        await target.pool.query(
          "SELECT state FROM model_requests WHERE id=$1",
          [pending.id],
        )
      ).rows[0].state,
      "unknown",
    );
    const recoveredExecution = new ExecutionStore(target, c.registry);
    const recoveredLease = await recoveredExecution.claim(c.engine.id);
    assert.equal(recoveredLease?.id, modelTask.id);
    assert.ok(recoveredLease);
    await assert.rejects(
      new ModelRequestStore(target).begin(
        recoveredLease,
        step,
        c.engine.id,
        { resourceId: c.engine.id },
        Date.now() + 1000,
        "recovery-fixture",
      ),
      { code: "MODEL_REMOTE_UNCERTAIN" },
    );
    await mkdir("test-results", { recursive: true });
    const report = {
      passed: true,
      databases: 2,
      stores: 2,
      objects: 2,
      revisionPreserved: true,
      idempotencyPreserved: true,
      modelQuarantinePreserved: true,
      elapsedMs: Math.round(performance.now() - started),
    };
    await writeFile(
      "test-results/recovery.json",
      JSON.stringify(report, null, 2),
    );
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    await c.close();
    await target.close();
  }
} finally {
  for (const name of created)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
async function transfer(database: string, path: string, input: boolean) {
  const connection = new URL(source),
    loopback = ["127.0.0.1", "localhost"].includes(connection.hostname),
    hostNetwork = loopback && process.platform === "linux",
    host =
      loopback && !hostNetwork ? "host.docker.internal" : connection.hostname;
  const args = [
    "run",
    "--rm",
    "-i",
    ...(hostNetwork ? ["--network", "host"] : []),
    "-e",
    "PGPASSWORD",
    "postgres:17-alpine",
    input ? "psql" : "pg_dump",
    "-h",
    host,
    "-p",
    connection.port || "5432",
    "-U",
    decodeURIComponent(connection.username),
    "-d",
    database,
    ...(input ? ["-v", "ON_ERROR_STOP=1"] : ["--no-owner", "--no-acl"]),
  ];
  const child = spawn("docker", args, {
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(connection.password),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("RECOVERY_TRANSFER_FAILED")),
    );
  });
  if (input) {
    child.stdout.resume();
    await Promise.all([pipeline(createReadStream(path), child.stdin), exited]);
  } else {
    child.stdin.end();
    await Promise.all([
      pipeline(
        child.stdout,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      ),
      exited,
    ]);
  }
}
