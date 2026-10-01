// 全新临时 Compose 项目验证真实镜像、进程重启、最小权限和备份；仅清理本次资源。
import { randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const id = randomBytes(6).toString("hex");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: `cloud-agent-smoke-${id}`,
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  RUNTIME_PASSWORD: randomBytes(24).toString("hex"),
  AUTH_MODE: "none",
  LOCAL_WORKSPACE: "default",
  LOCAL_PRINCIPAL: "owner",
  ARTIFACT_RETENTION_DAYS: "30",
  BOOTSTRAP_TOKEN: "",
  API_PORT: String(port),
  MODEL_MODE: "demo",
  COMPOSE_FILE: "compose.yaml:compose.files.yaml",
  EXAMPLES_ENABLED: "true",
  MODEL_PROFILES: "[]",
  MODEL_OPTIONS: "{}",
  ARTIFACT_STORES: "[]",
  DEPLOYMENT_MANAGED: "false",
  COST_POLICY: "",
  OIDC_AUTH: "",
  MEMORY_ENABLED: "false",
  EXECUTION_POOL: "default",
  EXECUTION_LABELS: "[]",
  TENANT_RATE_PER_MINUTE: "",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
  BUSINESS_PACKAGES: JSON.stringify([
    { id: "starter", config: {}, bindings: { output: "smoke-files" } },
  ]),
  CONNECTIONS: "[]",
  CONNECTION_CREDENTIALS_FILE: "",
  CONNECTION_CREDENTIALS: JSON.stringify({
    smoke: { signingKey: "smoke-local-only-signing-key-32-characters" },
  }),
  CHANNEL_ACCOUNTS: JSON.stringify([
    {
      id: "hook",
      provider: "webhook",
      workspace: "default",
      bindings: { fixture: "owner" },
      moduleId: "message-review",
      credential: "smoke",
      sendEnabled: false,
    },
  ]),
  ARTIFACT_STORE: JSON.stringify({
    provider: "local",
    id: "smoke-files",
    directory: "/app/files",
  }),
  DISPATCH_POLICY: JSON.stringify({
    workspaceConcurrency: 2,
    modules: { report: 1 },
  }),
  MAIL_MODE: "disabled",
  MAIL_ACCOUNTS: "[]",
  MAIL_CREDENTIALS: "{}",
  MAIL_CREDENTIALS_FILE: "",
  MAIL_SEND_ENABLED: "false",
};
const base = `http://127.0.0.1:${port}`;
const backup = `backups/smoke-${id}.sql`;
async function command(cmd, args) {
  const child = spawn(cmd, args, { env, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
async function api(path, body) {
  const response = await fetch(`${base}/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomBytes(16).toString("hex"),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `HTTP ${response.status} at ${path}`);
  return response.json();
}
async function until(read, ready) {
  for (let i = 0; i < 80; i++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(250);
  }
  throw new Error("Readiness timeout");
}
try {
  await command("docker", ["compose", "up", "-d", "--no-build", "--wait"]);
  await until(
    () =>
      fetch(`${base}/ready`)
        .then((r) => r.ok)
        .catch(() => false),
    (value) => value,
  );
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await api("/me")).principal.role, "superadmin");
  assert.equal((await api("/admin/mail")).enabled, false);
  // 在受限运行角色下验证新增检查点列、崩溃接管和失配费用，避免 owner 测试掩盖权限缺口。
  await command("docker", [
    "compose",
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
     import {z} from 'zod';
     import {createContainer} from './dist/apps/container.js';
     import {sourceDigest} from './dist/packages/contracts/source.js';
     let calls=0;
     const engine={id:'smoke-checkpoint',next:async()=>{calls++;return {text:'ok',calls:[],costUsd:0.125,costEstimated:false,inputTokens:1,outputTokens:1};}};
     const module={id:'smoke-checkpoint',version:'1',title:'checkpoint',description:'checkpoint',capability:'report:run',runtime:{model:true},input:z.object({}),example:{},tools:[],next:(_input,steps)=>steps.length?{kind:'complete',result:steps[0].output}:{kind:'model',key:'extract',request:{instructions:'',messages:[],tools:[],checkpoint:{key:'v1',sourceDigest:sourceDigest('source')}}}};
     const c=await createContainer(process.env,{modules:[module],engine});
     try {
       const actor=await c.identity.current('default','owner');
       const save=c.execution.checkpointModel.bind(c.execution);
       for(const mismatch of [false,true]) {
         const before=calls;
         c.execution.checkpointModel=async(...args)=>{await save(...args);await c.db.pool.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[args[0].id]);};
         const task=await c.service.create(actor,module.id,{},'checkpoint-'+mismatch);
         await c.worker.tick();
         assert.equal((await c.execution.steps(task.id))[0].status,'checkpointed');
         c.execution.checkpointModel=save;
         if(mismatch)await c.db.pool.query("UPDATE steps SET checkpoint_hash='outdated' WHERE task_id=$1",[task.id]);
         await c.worker.tick(); await c.worker.tick();
         const result=await c.tasks.get(actor,task.id);
         assert.equal(result.status,'succeeded');
         assert.equal(Number(result.cost_usd),mismatch?0.25:0.125);
         assert.equal(calls-before,mismatch?2:1);
       }
       engine.next=async()=>new Promise(()=>{});
       c.registry.register({...module,id:'smoke-unknown',version:'2',budget:{maxDurationMs:3000}});
       const uncertain=await c.service.create(actor,'smoke-unknown',{},'unknown-model');
       await c.worker.tick();
       const row=(await c.db.pool.query("SELECT state FROM model_requests WHERE task_id=$1",[uncertain.id])).rows[0];
       assert.equal(row.state,'unknown');
       await c.service.cancel(actor,uncertain.id);
       await c.worker.modelLifecycle.reconcile(()=>engine);
       assert.equal((await c.tasks.get(actor,uncertain.id)).status,'cancelled');
       console.log('Runtime role checkpoint, model ledger, uncertainty and cancellation passed');
     } finally {await c.close();}`,
  ]);

  const member = await api("/admin/principals", {
    id: "smoke-admin",
    role: "admin",
    capabilities: ["report:run"],
    enabled: true,
    expectedVersion: null,
    reason: "隔离环境管理员授权",
  });
  assert.equal(member.role, "admin");
  assert.ok(
    (await api("/admin/audit")).some(
      (entry) => entry.target_id === "smoke-admin",
    ),
  );
  const spec = await api("/openapi.json");
  assert.equal(spec.openapi, "3.1.0");
  const businessTask = await api("/tasks", {
    moduleId: "starter-report",
    input: { text: "business package smoke" },
  });
  const businessDone = await until(
    () => api(`/tasks/${businessTask.id}`),
    (d) => d.task.status === "succeeded",
  );
  assert.equal(businessDone.files.length, 1);
  assert.match(
    await (await fetch(`${base}/v1/files/${businessDone.files[0].id}`)).text(),
    /business package smoke/,
  );
  const fileTask = await api("/tasks", {
    moduleId: "file-report",
    input: { text: "durable file fixture" },
  });
  const fileDone = await until(
    () => api(`/tasks/${fileTask.id}`),
    (d) => d.task.status === "succeeded",
  );
  assert.equal(
    await (await fetch(`${base}/v1/files/${fileDone.task.result.id}`)).text(),
    "durable file fixture",
  );
  const stamp = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify({
    eventId: "smoke",
    subject: "fixture",
    threadId: "thread",
    input: { text: "confirm fixture" },
  });
  assert.equal(
    (
      await fetch(`${base}/hooks/channels/hook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-channel-time": stamp,
          "x-channel-signature": createHmac(
            "sha256",
            "smoke-local-only-signing-key-32-characters",
          )
            .update(`${stamp}.${raw}`)
            .digest("hex"),
        },
        body: raw,
      })
    ).status,
    202,
  );
  await until(
    () => api("/admin/channels"),
    (rows) => rows[0]?.outbox.some((row) => row.state === "draft"),
  );
  const task = await api("/tasks", {
    moduleId: "report",
    input: { values: [3, 6, 9] },
  });
  const waiting = await until(
    () => api(`/tasks/${task.id}`),
    (d) => d.task.status === "waiting_input",
  );
  await command("docker", ["compose", "restart", "worker", "api"]);
  await until(
    () =>
      fetch(`${base}/ready`)
        .then((r) => r.ok)
        .catch(() => false),
    (value) => value,
  );
  assert.equal(
    await (await fetch(`${base}/v1/files/${fileDone.task.result.id}`)).text(),
    "durable file fixture",
  );
  await api(`/tasks/${task.id}/inputs`, {
    waitId: waiting.waits[0].id,
    response: { title: "重启验收" },
  });
  const done = await until(
    () => api(`/tasks/${task.id}`),
    (d) => d.task.status === "succeeded",
  );
  assert.equal(done.task.result.sum, 18);
  // 隔离环境临时贡献一个中立表，验证真实运行角色的业务 schema 权限。
  await command("docker", [
    "compose",
    "run",
    "--rm",
    "migrate",
    "node",
    "--input-type=module",
    "-e",
    `import { Database } from './dist/packages/persistence/database.js';
     import { migrateBusiness } from './dist/packages/persistence/business.js';
     const db = new Database(process.env.DATABASE_URL);
     try { await migrateBusiness(db, { id: 'smoke-fixture', version: '1', migrations: [{ id: '001_records', sql: 'CREATE TABLE records(id integer PRIMARY KEY,value text NOT NULL)' }] }); }
     finally { await db.close(); }`,
  ]);
  const reviewed = await api("/tasks", {
    moduleId: "reviewed-report",
    input: { title: "确认验收", values: [10, 20] },
  });
  const approval = await until(
    () => api(`/tasks/${reviewed.id}`),
    (d) => d.task.status === "waiting_approval",
  );
  await api(`/waits/${approval.waits[0].id}/decisions`, {
    response: { approved: true },
  });
  const posted = await until(
    () => api(`/tasks/${reviewed.id}`),
    (d) => d.task.status === "succeeded",
  );
  assert.equal(posted.task.result.sum, 30);
  await command("docker", [
    "compose",
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    "import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});await p.query(\"INSERT INTO business_smoke_fixture.records VALUES(1,'initial')\");await p.query(\"UPDATE business_smoke_fixture.records SET value='updated' WHERE id=1\");if((await p.query('SELECT value FROM business_smoke_fixture.records WHERE id=1')).rows[0]?.value!=='updated')throw Error('BUSINESS_DML_FAILED');await p.query('DELETE FROM business_smoke_fixture.records WHERE id=1');for(const sql of ['CREATE TABLE denied(id integer)','UPDATE principals SET enabled=false','DELETE FROM administration_audit','DELETE FROM administration_commands','DELETE FROM mail_audit','DELETE FROM channel_audit','DELETE FROM task_archives','DELETE FROM task_reconciliations','UPDATE context_snapshots SET provider_id=provider_id','DELETE FROM governance_commands','DELETE FROM token_audit','DELETE FROM business_requests','UPDATE platform_maintenance SET enabled=true','DELETE FROM deployment_activation','CREATE TABLE business_smoke_fixture.denied(id integer)']){try{await p.query(sql);throw new Error('unexpected permission');}catch(e){if(e.code!=='42501')throw e;}}await p.query(\"INSERT INTO mailboxes(id,workspace_id,remote_id) VALUES('compose-fixture','default','compose-fixture')\");await p.query(\"INSERT INTO mail_audit(mailbox,actor,action,target,reason) VALUES('compose-fixture','owner','smoke','mailbox','fixture')\");await p.end();console.log('Runtime mail access verified; DDL and audit mutations denied');",
  ]);
  const eventsBefore = await api(`/tasks/${task.id}/events?format=json`);
  await command("docker", [
    "compose",
    "run",
    "--rm",
    "migrate",
    "node",
    "--input-type=module",
    "-e",
    "import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});await p.query(\"UPDATE tasks SET updated_at=now()-interval '31 days' WHERE status IN ('succeeded','failed','cancelled')\");await p.end();",
  ]);
  await command("docker", [
    "compose",
    "run",
    "--rm",
    "-e",
    "RETENTION_DAYS=30",
    "migrate",
    "node",
    "dist/scripts/archive.js",
    "--apply",
  ]);
  assert.deepEqual(
    await api(`/tasks/${task.id}/events?format=json`),
    eventsBefore,
  );
  // 真实容器验证多供应商装配和健康表授权；缺凭据在联网之前失败，绝不访问外部邮箱。
  env.MAIL_MODE = "accounts";
  const common = {
    address: "fixture@example.test",
    workspace: "default",
    bindings: { "user@example.test": "owner" },
    credential: "missing",
    sendEnabled: false,
  };
  env.MAIL_ACCOUNTS = JSON.stringify([
    {
      ...common,
      id: "service",
      provider: "agentmail",
      inbox: "fixture@example.test",
    },
    {
      ...common,
      id: "standard",
      provider: "imap-smtp",
      user: "fixture@example.test",
      imap: { host: "imap.invalid", port: 993, tls: "implicit" },
      smtp: { host: "smtp.invalid", port: 465, tls: "implicit" },
    },
  ]);
  await command("docker", [
    "compose",
    "up",
    "-d",
    "--no-build",
    "--wait",
    "api",
    "worker",
  ]);
  const mail = await until(
    () => api("/admin/mail"),
    (data) =>
      data.accounts.length === 2 &&
      data.accounts.every(
        (account) =>
          account.mailbox.blocked_reason && account.health.length === 3,
      ),
  );
  assert.ok(
    mail.accounts.every(
      (account) =>
        account.mailbox.blocked_reason === "MAIL_CREDENTIAL_UNAVAILABLE",
    ),
  );
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  assert.match(
    await (await fetch(`${base}/v1/metrics`)).text(),
    /cloud_agent_mail_account_blocked\{account="standard"\} 1/,
  );
  await command("node", ["scripts/backup.mjs", backup]);
  await command("node", ["scripts/restore-check.mjs", backup]);
  process.stdout.write(
    "Compose smoke passed: API/Worker restart, report, tool approval, runtime permissions, archive replay, multi-mailbox isolation, signed channel, durable files, backup and isolated restore\n",
  );
} catch (error) {
  await command("docker", [
    "compose",
    "logs",
    "--tail",
    "40",
    "api",
    "worker",
    "migrate",
  ]);
  throw error;
} finally {
  await command("docker", ["compose", "down", "--volumes", "--remove-orphans"]);
  await rm(backup, { force: true });
}
