import type {
  TaskPort,
  TaskDetail,
  ConversationRow,
  MessageRow,
} from "../runtime/ports.js";
/** 任务入口与查询仓储；所有用户访问都限定 workspace 和资源所有者。 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  Problem,
  requireCapability,
  type Data,
  type Json,
  type Principal,
  type Task,
  type Step,
} from "../contracts/index.js";
import { readArchives, type StoredEvent } from "./archive.js";
import { Database } from "./database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { revisionId } from "../contracts/deployment.js";
import type { Registry } from "../runtime/registry.js";
import { event, ownedTask, lockTaskTree } from "./task-helpers.js";
export { event, ownedTask, lockTaskTree } from "./task-helpers.js";
export class TaskStore implements TaskPort {
  constructor(
    readonly db: Database,
    private registry: Registry,
    private managedDeployment = false,
    private telemetry?: import("../observability/tracing.js").Telemetry,
    private queueLimit?: number,
  ) {}
  async workspaceTask(workspace: string, id: string) {
    const row = (
      await this.db.pool.query<Task>(
        "SELECT * FROM tasks WHERE workspace_id=$1 AND id=$2",
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new Problem(404, "TASK_NOT_FOUND");
    return row;
  }
  async children(id: string) {
    return (
      await this.db.pool.query<Task>(
        "SELECT * FROM tasks WHERE parent_id=$1 ORDER BY created_at",
        [id],
      )
    ).rows;
  }
  async steps(taskId: string) {
    return (
      await this.db.pool.query<Step>(
        "SELECT * FROM steps WHERE task_id=$1 ORDER BY created_at,id",
        [taskId],
      )
    ).rows;
  }
  async artifact(id: string) {
    return (
      await this.db.pool.query<{
        task_id: string;
        title: string;
        content: unknown;
        media_type: string;
      }>("SELECT task_id,title,content,media_type FROM artifacts WHERE id=$1", [
        id,
      ])
    ).rows[0];
  }
  async conversations(principal: Principal) {
    return (
      await this.db.pool.query<ConversationRow>(
        "SELECT id,title,created_at FROM conversations WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC LIMIT 50",
        [principal.workspace_id, principal.id],
      )
    ).rows;
  }
  async conversationTasks(principal: Principal, id: string) {
    const exists = await this.db.pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
      [id, principal.workspace_id, principal.id],
    );
    if (!exists.rowCount) throw new Problem(404, "CONVERSATION_NOT_FOUND");
    return (
      await this.db.pool.query<Task>(
        "SELECT * FROM tasks WHERE conversation_id=$1",
        [id],
      )
    ).rows;
  }
  async conversationMessages(id: string) {
    return (
      await this.db.pool.query<MessageRow>(
        "SELECT id,task_id,role,content,created_at FROM messages WHERE conversation_id=$1 ORDER BY id LIMIT 200",
        [id],
      )
    ).rows;
  }
  /** 客户端请求键在身份范围唯一，重放不同内容返回冲突。 */
  async create(
    principal: Principal,
    moduleId: string,
    input: Data,
    key: string,
    conversationId?: string,
  ): Promise<Task> {
    return this.db.transaction((client) =>
      this.createInTransaction(
        client,
        principal,
        moduleId,
        input,
        key,
        conversationId,
      ),
    );
  }
  async createInTransaction(
    client: PoolClient,
    principal: Principal,
    moduleId: string,
    input: Data,
    key: string,
    conversationId?: string,
  ): Promise<Task> {
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtext('deployment-activation'))",
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${principal.workspace_id}:${principal.id}:${key}`,
    ]);
    const existing = (
      await client.query<Task & { request_hash: string }>(
        "SELECT * FROM tasks WHERE workspace_id=$1 AND principal_id=$2 AND request_key=$3",
        [principal.workspace_id, principal.id, key],
      )
    ).rows[0];
    if (existing && existing.module_id !== moduleId)
      throw new Problem(409, "IDEMPOTENCY_CONFLICT");
    if (existing && (existing as Task & { retired_at?: Date }).retired_at)
      throw new Problem(410, "TASK_DATA_RETIRED");
    const module = this.registry.get(moduleId, existing?.module_version);
    requireCapability(principal, module.capability);
    const normalized = module.input.parse(input) as Data;
    const hash = fingerprint({
      moduleId,
      input: normalized,
      conversationId: conversationId ?? null,
    });
    if (existing) {
      if (existing.request_hash !== hash)
        throw new Problem(409, "IDEMPOTENCY_CONFLICT");
      return existing;
    }
    await this.assertAdmission(client, moduleId);
    const revision = await this.admit(client, principal);
    const id = randomUUID();
    const conversation = conversationId ?? randomUUID();
    if (conversationId) {
      const owned = await client.query(
        "SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
        [conversationId, principal.workspace_id, principal.id],
      );
      if (!owned.rowCount) throw new Problem(404, "CONVERSATION_NOT_FOUND");
    } else {
      await client.query(
        "INSERT INTO conversations(id,workspace_id,principal_id,title) VALUES($1,$2,$3,$4)",
        [conversation, principal.workspace_id, principal.id, module.title],
      );
    }
    const task = (
      await client.query<Task>(
        `INSERT INTO tasks(id,workspace_id,principal_id,conversation_id,module_id,module_version,config_hash,input,request_key,request_hash,status,budget,deployment_revision,trace_context,execution_pool,execution_labels)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14,$15) RETURNING *`,
        [
          id,
          principal.workspace_id,
          principal.id,
          conversation,
          module.id,
          module.version,
          this.registry.hash(module),
          JSON.stringify(normalized),
          key,
          hash,
          JSON.stringify(this.registry.budget(module)),
          revision,
          JSON.stringify(this.telemetry?.current() ?? null),
          module.runtime?.pool ?? "default",
          module.runtime?.labels ?? [],
        ],
      )
    ).rows[0]!;
    await client.query(
      "INSERT INTO messages(conversation_id,task_id,role,content) VALUES($1,$2,'user',$3)",
      [conversation, id, JSON.stringify(normalized)],
    );
    await event(client, id, "task.created", {
      module: module.id,
      version: module.version,
    });
    return task;
  }
  private async admit(client: PoolClient, principal: Principal) {
    if (this.queueLimit) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `queue:${principal.workspace_id}`,
      ]);
      const count = (
        await client.query<{ count: string }>(
          "SELECT count(*)::text FROM tasks WHERE workspace_id=$1 AND status NOT IN ('succeeded','failed','cancelled')",
          [principal.workspace_id],
        )
      ).rows[0]!;
      if (Number(count.count) >= this.queueLimit)
        throw new Problem(429, "WORKSPACE_BACKLOG_LIMIT");
    }
    const manifest = this.registry.deployment(),
      revision = revisionId(manifest);
    await client.query(
      "INSERT INTO deployment_revisions(id,manifest) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [revision, JSON.stringify(manifest)],
    );
    if (this.managedDeployment) {
      const active = (
        await client.query<{ revision_id: string }>(
          "SELECT runtime_deployment_revision() AS revision_id",
        )
      ).rows[0];
      if (active?.revision_id !== revision)
        throw new Problem(409, "DEPLOYMENT_NOT_ACTIVE");
    }
    if (
      (await client.query("SELECT runtime_maintenance_enabled() AS enabled"))
        .rows[0]?.enabled
    )
      throw new Problem(503, "MAINTENANCE_ACTIVE");
    return revision;
  }
  /** 外部线程映射在身份范围内稳定，不让通道直接维护任务会话表。 */
  async conversationFor(
    principal: Principal,
    namespace: string,
    key: string,
    title: string,
  ) {
    return this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify([principal.workspace_id, principal.id, namespace, key]),
      ]);
      const previous = (
        await client.query<{ conversation_id: string }>(
          "SELECT conversation_id FROM conversation_bindings WHERE workspace_id=$1 AND principal_id=$2 AND namespace=$3 AND external_key=$4",
          [principal.workspace_id, principal.id, namespace, key],
        )
      ).rows[0];
      if (previous) return previous.conversation_id;
      const id = randomUUID();
      await client.query(
        "INSERT INTO conversations(id,workspace_id,principal_id,title) VALUES($1,$2,$3,$4)",
        [id, principal.workspace_id, principal.id, title],
      );
      await client.query(
        "INSERT INTO conversation_bindings VALUES($1,$2,$3,$4,$5)",
        [principal.workspace_id, principal.id, namespace, key, id],
      );
      return id;
    });
  }
  async waitTask(waitId: string): Promise<string> {
    const row = (
      await this.db.pool.query<{ task_id: string }>(
        "SELECT task_id FROM waits WHERE id=$1",
        [waitId],
      )
    ).rows[0];
    if (!row) throw new Problem(404, "WAIT_NOT_FOUND");
    return row.task_id;
  }
  async notification(principal: Principal, id: string) {
    return this.db.transaction(async (client) => {
      // 锁任务保证状态与等待属于同一时刻，避免输入刚消费时把下一个确认通知写成旧状态。
      const task = await ownedTask(client, principal, id, true);
      const wait = (
        await client.query<{ id: string; reason: string; schema: Json }>(
          "SELECT id,reason,schema FROM waits WHERE task_id=$1 AND status='pending' AND kind IN ('input','approval') AND expires_at>now() LIMIT 1",
          [id],
        )
      ).rows[0];
      if (
        !["succeeded", "failed", "cancelled"].includes(task.status) &&
        !(wait && ["waiting_input", "waiting_approval"].includes(task.status))
      )
        return null;
      return {
        task,
        key: wait?.id ?? task.status,
        waitId: wait?.id ?? null,
        reason: wait?.reason ?? "",
        schema: wait?.schema ?? {},
      };
    });
  }
  async get(principal: Principal, id: string): Promise<Task> {
    return this.db.transaction((client) => ownedTask(client, principal, id));
  }
  async list(principal: Principal, offset = 0) {
    return (
      await this.db.pool.query<Task>(
        "SELECT * FROM tasks WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $3",
        [principal.workspace_id, principal.id, offset],
      )
    ).rows;
  }
  async page(principal: Principal, cursor?: { time: string; id: string }) {
    return (
      await this.db.pool.query<Task & { cursor_at: string }>(
        "SELECT *,created_at::text AS cursor_at FROM tasks WHERE workspace_id=$1 AND principal_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51",
        [
          principal.workspace_id,
          principal.id,
          cursor?.time ?? null,
          cursor?.id ?? null,
        ],
      )
    ).rows;
  }
  async detail(principal: Principal, id: string): Promise<TaskDetail> {
    return this.db.transaction(async (client) => {
      const task = await ownedTask(client, principal, id);
      const steps = (
        await client.query<TaskDetail["steps"][number]>(
          "SELECT id,key,kind,status,attempts,output FROM steps WHERE task_id=$1 ORDER BY created_at,id",
          [id],
        )
      ).rows;
      const waits = (
        await client.query<TaskDetail["waits"][number]>(
          "SELECT id,kind,reason,schema,status,response,expires_at FROM waits WHERE task_id=$1 ORDER BY expires_at",
          [id],
        )
      ).rows;
      const artifacts = (
        await client.query<TaskDetail["artifacts"][number]>(
          "SELECT id,title,media_type,created_at FROM artifacts WHERE task_id=$1",
          [id],
        )
      ).rows;
      const invocations = (
        await client.query<TaskDetail["invocations"][number]>(
          "SELECT id,tool_name,effect,status,receipt,reconciliation_ref FROM tool_invocations WHERE task_id=$1",
          [id],
        )
      ).rows;
      const files = (
        await client.query<TaskDetail["files"][number]>(
          "SELECT id,name,media_type,bytes,digest FROM file_artifacts WHERE task_id=$1 AND state='ready' AND expires_at>now() ORDER BY created_at,id",
          [id],
        )
      ).rows;
      const modelRequests = (
        await client.query<TaskDetail["modelRequests"][number]>(
          "SELECT id,state,remote_state,quarantine_until,cost_usd,usage_complete FROM model_requests WHERE task_id=$1 ORDER BY created_at,id",
          [id],
        )
      ).rows;
      return {
        task,
        steps,
        waits,
        artifacts,
        invocations,
        files,
        modelRequests,
      };
    });
  }
  async events(principal: Principal, id: string, after: string) {
    return this.db.transaction(async (client) => {
      await ownedTask(client, principal, id, true);
      const hot = (
        await client.query<StoredEvent>(
          "SELECT id::text,task_id,type,data,created_at FROM events WHERE task_id=$1 AND id>$2::bigint ORDER BY events.id LIMIT 100",
          [id, after],
        )
      ).rows;
      const cold = (await readArchives(client, id))
        .flatMap((a) => a.events)
        .filter((e) => BigInt(e.id) > BigInt(after));
      return [...cold, ...hot]
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .slice(0, 100)
        .map(({ id, type, data, created_at }) => ({
          id,
          type,
          data,
          created_at,
        }));
    });
  }
  async cancel(principal: Principal, id: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await lockTaskTree(client, id);
      const task = await ownedTask(client, principal, id, true);
      if (["succeeded", "cancelled", "failed"].includes(task.status)) return;
      const descendants = (
        await client.query<{ id: string }>(
          "WITH RECURSIVE tree AS (SELECT id FROM tasks WHERE parent_id=$1 UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id=tree.id) SELECT id FROM tree",
          [id],
        )
      ).rows.map((r) => r.id);
      if (descendants.length) {
        await client.query(
          "UPDATE tool_invocations SET status='unknown' WHERE task_id=ANY($1::uuid[]) AND status='dispatching'",
          [descendants],
        );
        await client.query(
          "UPDATE tasks SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=ANY($1::uuid[]) AND status NOT IN ('succeeded','failed','cancelled')",
          [descendants],
        );
        await client.query(
          "UPDATE waits SET status='cancelled' WHERE task_id=ANY($1::uuid[]) AND status='pending'",
          [descendants],
        );
        await client.query(
          "UPDATE runs SET status='cancelled',ended_at=now() WHERE task_id=ANY($1::uuid[]) AND status='running'",
          [descendants],
        );
        for (const child of descendants)
          await event(client, child, "parent.cancelled", {
            parentId: id,
            sideEffectsMayExist: true,
          });
      }
      // 取消只撤销后续执行权；已发送的写操作仍保留为未知，供运维对账。
      await client.query(
        "UPDATE tool_invocations SET status='unknown' WHERE task_id=$1 AND status='dispatching'",
        [id],
      );
      await client.query(
        "UPDATE tasks SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await client.query(
        "UPDATE waits SET status='cancelled' WHERE task_id=$1 AND status='pending'",
        [id],
      );
      await client.query(
        "UPDATE runs SET status='cancelled',ended_at=now() WHERE task_id=$1 AND status='running'",
        [id],
      );
      await event(client, id, "task.cancelled", { sideEffectsMayExist: true });
    });
  }
  private async assertAdmission(client: PoolClient, moduleId: string) {
    if (
      (
        await client.query(
          "SELECT 1 FROM module_drains WHERE module_id=$1 AND draining",
          [moduleId],
        )
      ).rowCount
    )
      throw new Problem(409, "MODULE_DRAINING");
  }
  async retry(principal: Principal, id: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('deployment-activation'))",
      );
      const task = await ownedTask(client, principal, id, true);
      if ((task as Task & { retired_at?: Date }).retired_at)
        throw new Problem(410, "TASK_DATA_RETIRED");
      requireCapability(
        principal,
        this.registry.get(task.module_id, task.module_version).capability,
      );
      await this.assertAdmission(client, task.module_id);
      if (!["failed", "waiting_external"].includes(task.status))
        throw new Problem(409, "NOT_RETRYABLE");
      // 只复核尚未完成的确认步骤；已执行动作的确认过期不阻止后续对账。
      const closedApproval = (
        await client.query<{ rejected: boolean }>(
          `SELECT (w.status='consumed' AND w.response->>'approved' IS DISTINCT FROM 'true') AS rejected
           FROM waits w JOIN steps s ON s.id=w.step_id
           WHERE w.task_id=$1 AND w.kind='approval' AND s.status<>'succeeded'
           AND (w.status IN ('expired','cancelled') OR w.expires_at<=now()
             OR (w.status='consumed' AND w.response->>'approved' IS DISTINCT FROM 'true')) LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (closedApproval)
        throw new Problem(
          409,
          closedApproval.rejected ? "APPROVAL_REJECTED" : "APPROVAL_EXPIRED",
        );
      const unsafe = await client.query(
        "SELECT id FROM tool_invocations WHERE task_id=$1 AND status IN ('unknown','dispatching') AND effect='unsafe_write'",
        [id],
      );
      if (unsafe.rowCount)
        throw new Problem(409, "MANUAL_RECONCILIATION_REQUIRED");
      const pendingWait = await client.query(
        "SELECT id FROM waits WHERE task_id=$1 AND status='pending'",
        [id],
      );
      if (pendingWait.rowCount) throw new Problem(409, "RESPOND_TO_WAIT");
      const children = await client.query(
        "SELECT 1 FROM tasks WHERE parent_id=$1 AND status IN ('failed','cancelled')",
        [id],
      );
      if (children.rowCount) throw new Problem(409, "CHILD_RECOVERY_REQUIRED");
      await client.query(
        "UPDATE task_groups g SET settled=false FROM steps s WHERE g.step_id=s.id AND g.parent_id=$1 AND s.status='failed'",
        [id],
      );
      // 重试不重置累计预算、逻辑动作或已经完成的步骤。
      await client.query(
        "UPDATE steps SET status='pending' WHERE task_id=$1 AND status='failed'",
        [id],
      );
      await client.query(
        "UPDATE tasks SET status='queued',error=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await event(client, id, "task.retry_requested");
    });
  }
}
