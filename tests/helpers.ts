/** 集成测试在真实 PostgreSQL 上构造隔离身份与业务，不访问生产服务。 */
import { createModules, registeredCapabilities } from "../apps/modules.js";
import { effectModule, prepareEffects } from "./fixtures/effects.js";
import { tokenHash } from "../packages/persistence/database.js";
import { createContainer, type Container } from "../apps/container.js";
import { type Principal, type Task } from "../packages/contracts/index.js";
export const token = "test-owner-token-that-is-not-for-deployment";
export const otherToken = "test-other-workspace-token-not-for-deployment";
export const principal: Principal = {
  id: "owner",
  workspace_id: "workspace-a",
  enabled: true,
  role: "member",
  capabilities: [...registeredCapabilities(createModules()), "effect:write"],
};
export async function setup(): Promise<Container> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.startsWith("/cloud_agent_test_"))
    throw new Error("Use pnpm test:integration to create an isolated database");
  const container = await createContainer({
    DATABASE_URL: url,
    AUTH_MODE: "token",
    LOCAL_WORKSPACE: "workspace-a",
    LOCAL_PRINCIPAL: "owner",
    HOST: "127.0.0.1",
    PORT: 3100,
    MODEL_MODE: "demo",
    LLM_BASE_URL: "https://example.invalid/v1",
    LLM_MODEL: "fixture",
    LLM_INPUT_PRICE: 1,
    LLM_OUTPUT_PRICE: 4,
    WORKER_CONCURRENCY: 2,
  });
  await container.db.migrate();
  await prepareEffects(container.db);
  await container.db.pool.query(
    "UPDATE platform_maintenance SET enabled=false,reason=''",
  );
  await container.db.pool.query(
    "TRUNCATE governance_commands,token_audit,business_jobs,deployment_activation,business_requests,delegation_audit",
  );
  container.registry.register(effectModule(container.db));
  await container.db.pool.query(
    "TRUNCATE artifact_stores,dispatch_turns,connection_rates,file_artifacts,channel_accounts,loop_health,mailboxes,administration_commands,administration_audit,external_signals,principals,conversations,tasks,messages,runs,steps,tool_invocations,invocation_attempts,waits,inbound_events,artifacts,events,schedules,worker_heartbeats,fixture_effects CASCADE",
  );
  for (const [workspace, auth] of [
    ["workspace-a", token],
    ["workspace-b", otherToken],
  ])
    await container.db.pool.query(
      "INSERT INTO principals(id,workspace_id,token_hash,capabilities) VALUES($1,$2,$3,$4)",
      [principal.id, workspace, tokenHash(auth!), principal.capabilities],
    );
  return container;
}
export async function drain(container: Container, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) if (!(await container.worker.tick())) return;
  throw new Error("Worker did not quiesce");
}
export async function expired(container: Container, task: Task) {
  await container.db.pool.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [task.id],
  );
}
