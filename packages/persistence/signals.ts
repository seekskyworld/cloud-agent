/** 外部回调先入库再匹配等待；只允许绑定任务所有者的服务身份投递。 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { compileJsonSchema } from "../contracts/json-schema.js";
import {
  Problem,
  requireCapability,
  type Data,
  type Principal,
  type Task,
} from "../contracts/index.js";
import type { Database } from "./database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { event, ownedTask } from "./tasks.js";
/** 在已锁住任务的事务内匹配，保证取消与回调不会同时胜出。 */
export async function consumeSignal(
  client: PoolClient,
  taskId: string,
): Promise<void> {
  const row = (
    await client.query<{
      signal_id: string;
      wait_id: string;
      step_id: string;
      schema: object;
      response: Data;
      expires_at: Date;
    }>(
      `SELECT s.id AS signal_id,w.id AS wait_id,w.step_id,w.schema,s.response,w.expires_at FROM external_signals s JOIN steps st ON st.task_id=s.task_id AND st.key=s.wait_key JOIN waits w ON w.step_id=st.id WHERE s.task_id=$1 AND s.status='pending' AND w.status='pending' AND w.kind='external'`,
      [taskId],
    )
  ).rows[0];
  if (!row) return;
  if (row.expires_at.getTime() <= Date.now()) return;
  const valid = compileJsonSchema(row.schema)(row.response);
  await client.query("UPDATE external_signals SET status=$2 WHERE id=$1", [
    row.signal_id,
    valid ? "consumed" : "rejected",
  ]);
  await client.query("UPDATE waits SET status=$2,response=$3 WHERE id=$1", [
    row.wait_id,
    valid ? "consumed" : "rejected",
    JSON.stringify(row.response),
  ]);
  await client.query("UPDATE steps SET status=$2,output=$3 WHERE id=$1", [
    row.step_id,
    valid ? "succeeded" : "failed",
    JSON.stringify(row.response),
  ]);
  await client.query(
    "UPDATE tasks SET status=$2,error=$3,available_at=now(),updated_at=now() WHERE id=$1",
    [
      taskId,
      valid ? "queued" : "failed",
      valid ? null : "INVALID_EXTERNAL_RESPONSE",
    ],
  );
  await event(client, taskId, valid ? "signal.consumed" : "signal.rejected", {
    signalId: row.signal_id,
    waitId: row.wait_id,
  });
}
export class SignalStore {
  constructor(private db: Database) {}
  async receive(
    principal: Principal,
    taskId: string,
    waitKey: string,
    response: Data,
    key: string,
  ): Promise<void> {
    requireCapability(principal, "task:signal");
    await this.db.transaction(async (client) => {
      const task: Task = await ownedTask(client, principal, taskId, true);
      await this.record(client, task, principal, waitKey, response, key);
    });
  }
  /** 只由可信邮件适配调用；目标用户/任务/等待键来自持久请求，不接受回执自报。 */
  async receiveMailReceipt(
    client: PoolClient,
    actor: Principal,
    requestId: string,
    response: Data,
    key: string,
    capability = "task:signal",
  ) {
    const current = (
      await client.query<Principal>(
        "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
        [actor.workspace_id, actor.id],
      )
    ).rows[0];
    if (!current) throw new Problem(403, "IDENTITY_REVOKED");
    requireCapability(current, "task:signal");
    requireCapability(current, capability);
    const binding = (
      await client.query<{
        source_task: string;
        actor_id: string;
        wait_key: string;
      }>(
        `SELECT o.source_task,o.actor_id,o.wait_key FROM mail_outbox o JOIN mailboxes b ON b.id=o.mailbox
       WHERE o.id=$1 AND b.workspace_id=$2 AND o.business_policy IS NOT NULL AND o.wait_key IS NOT NULL`,
        [requestId, current.workspace_id],
      )
    ).rows[0];
    if (!binding) throw new Problem(404, "MAIL_RECEIPT_UNBOUND");
    const owner = { workspace_id: current.workspace_id, id: binding.actor_id };
    const task = (
      await client.query<Task>(
        "SELECT * FROM tasks WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 FOR UPDATE",
        [binding.source_task, owner.workspace_id, owner.id],
      )
    ).rows[0];
    if (!task) throw new Problem(404, "TASK_NOT_FOUND");
    await this.record(
      client,
      task,
      owner,
      binding.wait_key,
      response,
      key,
      current.id,
    );
  }
  private async record(
    client: PoolClient,
    task: Task,
    principal: Pick<Principal, "id" | "workspace_id">,
    waitKey: string,
    response: Data,
    key: string,
    serviceActor?: string,
  ) {
    const taskId = task.id;
    const hash = fingerprint({ taskId, waitKey, response });
    const old = (
      await client.query<{ request_hash: string }>(
        "SELECT request_hash FROM external_signals WHERE workspace_id=$1 AND principal_id=$2 AND event_key=$3",
        [principal.workspace_id, principal.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash) throw new Problem(409, "EVENT_CONFLICT");
      return;
    }
    if (["succeeded", "failed", "cancelled"].includes(task.status))
      throw new Problem(409, "TASK_CLOSED");
    if (
      (
        await client.query(
          "SELECT id FROM external_signals WHERE task_id=$1 AND wait_key=$2",
          [taskId, waitKey],
        )
      ).rowCount
    )
      throw new Problem(409, "SIGNAL_ALREADY_EXISTS");
    await client.query(
      "INSERT INTO external_signals(id,task_id,wait_key,workspace_id,principal_id,event_key,response,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        taskId,
        waitKey,
        principal.workspace_id,
        principal.id,
        key,
        JSON.stringify(response),
        hash,
      ],
    );
    await event(client, taskId, "signal.received", {
      waitKey,
      ...(serviceActor ? { serviceActor } : {}),
    });
    if (task.status === "waiting_external") await consumeSignal(client, taskId);
  }
}
