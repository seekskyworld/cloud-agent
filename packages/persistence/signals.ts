/** 外部回调先入库再匹配等待；只允许绑定任务所有者的服务身份投递。 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Ajv } from "ajv";
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
const validator = new Ajv({ strict: false });
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
  const valid = validator.validate(row.schema, row.response);
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
      await event(client, taskId, "signal.received", { waitKey });
      if (task.status === "waiting_external")
        await consumeSignal(client, taskId);
    });
  }
}
