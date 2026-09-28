import { authorizeDelegation } from "../identity/delegation.js";
/** 等待条件、输入去重与重新入队共同提交，避免确认丢失或重复消费。 */
import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import {
  Problem,
  requireCapability,
  type Action,
  type Data,
  type Principal,
  type Step,
  type Task,
} from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { event, ownedTask } from "./task-helpers.js";
import { ExecutionStore } from "./execution.js";
import { consumeSignal } from "./signals.js";
const validator = new Ajv({ strict: false });
type WaitRow = {
  id: string;
  task_id: string;
  step_id: string;
  kind: string;
  capability: string | null;
  binding_hash: string;
  status: string;
  schema: object;
  expires_at: Date;
  response: Data | null;
};
export class WaitStore {
  constructor(private execution: ExecutionStore) {}
  async suspend(
    task: Task,
    step: Step,
    action: Extract<Action, { kind: "wait" }>,
  ): Promise<boolean> {
    return this.execution.db.transaction(async (client) => {
      await this.execution.lock(client, task);
      const existing = (
        await client.query<WaitRow>("SELECT * FROM waits WHERE step_id=$1", [
          step.id,
        ])
      ).rows[0];
      const binding = fingerprint(step.request);
      if (existing?.status === "consumed") {
        if (
          action.waitKind === "approval" &&
          existing.response?.approved !== true
        )
          throw new Problem(403, "APPROVAL_REJECTED");
        if (
          action.waitKind === "approval" &&
          existing.expires_at.getTime() <= Date.now()
        )
          throw new Problem(409, "APPROVAL_EXPIRED");
        if (existing.binding_hash !== binding)
          throw new Problem(409, "APPROVAL_BINDING_CHANGED");
        return false;
      }
      if (existing) throw new Problem(409, "WAIT_NOT_ACTIVE");
      await client.query(
        "INSERT INTO waits(id,task_id,step_id,kind,reason,schema,capability,binding_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 millisecond')",
        [
          randomUUID(),
          task.id,
          step.id,
          action.waitKind,
          action.reason,
          JSON.stringify(action.schema),
          action.capability ?? null,
          binding,
          action.expiresInMs,
        ],
      );
      const status =
        action.waitKind === "input"
          ? "waiting_input"
          : action.waitKind === "approval"
            ? "waiting_approval"
            : "waiting_external";
      await client.query("UPDATE steps SET status='waiting' WHERE id=$1", [
        step.id,
      ]);
      await this.execution.release(client, task, status);
      await event(client, task.id, "task.waiting", {
        kind: action.waitKind,
        reason: action.reason,
      });
      if (action.waitKind === "external") await consumeSignal(client, task.id);
      return true;
    });
  }
  async respond(
    principal: Principal,
    waitId: string,
    response: Data,
    key: string,
    expectedTask?: string,
    delegate?: Principal,
    delegateCapability?: string,
  ): Promise<void> {
    await this.execution.db.transaction(async (client) => {
      const waitRef = (
        await client.query<WaitRow>("SELECT * FROM waits WHERE id=$1", [waitId])
      ).rows[0];
      if (!waitRef || (expectedTask && expectedTask !== waitRef.task_id))
        throw new Problem(404, "WAIT_NOT_FOUND");
      const task = await ownedTask(client, principal, waitRef.task_id, true);
      const wait = (
        await client.query<WaitRow>(
          "SELECT * FROM waits WHERE id=$1 FOR UPDATE",
          [waitId],
        )
      ).rows[0]!;
      principal = await this.responseActor(
        client,
        principal,
        task,
        wait,
        delegate,
        delegateCapability,
      );
      const hash = fingerprint({ waitId, response });
      const previous = (
        await client.query<{ request_hash: string }>(
          "SELECT request_hash FROM inbound_events WHERE workspace_id=$1 AND principal_id=$2 AND event_key=$3",
          [principal.workspace_id, principal.id, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new Problem(409, "EVENT_CONFLICT");
        return;
      }
      if (
        !task.status.startsWith("waiting_") ||
        wait.status !== "pending" ||
        wait.expires_at.getTime() <= Date.now()
      )
        throw new Problem(409, "WAIT_CLOSED");
      if (!validator.validate(wait.schema, response))
        throw new Problem(400, "INVALID_WAIT_RESPONSE");
      await client.query(
        "INSERT INTO inbound_events(id,workspace_id,principal_id,event_key,request_hash,wait_id,response) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          principal.workspace_id,
          principal.id,
          key,
          hash,
          waitId,
          JSON.stringify(response),
        ],
      );
      await client.query(
        "UPDATE waits SET status='consumed',response=$2,consumed_by=$3 WHERE id=$1",
        [waitId, JSON.stringify(response), delegate?.id ?? principal.id],
      );
      const denied = wait.kind === "approval" && response.approved !== true;
      // 审批工具步骤尚未执行，普通输入步骤则已完成；两者不能混为一类。
      await client.query(
        "UPDATE steps SET status=CASE WHEN kind='wait' THEN 'succeeded' ELSE 'pending' END,output=CASE WHEN kind='wait' THEN $2::jsonb ELSE output END WHERE id=$1",
        [wait.step_id, JSON.stringify(response)],
      );
      await client.query(
        "UPDATE tasks SET status=$2,error=$3,available_at=now(),updated_at=now() WHERE id=$1",
        [
          task.id,
          denied ? "failed" : "queued",
          denied ? "APPROVAL_REJECTED" : null,
        ],
      );
      await client.query(
        "INSERT INTO messages(conversation_id,task_id,role,content) VALUES($1,$2,'user',$3)",
        [task.conversation_id, task.id, JSON.stringify(response)],
      );
      await event(
        client,
        task.id,
        denied ? "approval.rejected" : "wait.consumed",
        { waitId, actor: delegate?.id ?? principal.id },
      );
    });
  }
  private async responseActor(
    client: import("pg").PoolClient,
    principal: Principal,
    task: Task,
    wait: WaitRow,
    delegate?: Principal,
    delegateCapability?: string,
  ) {
    if (delegate) {
      if (wait.kind !== "approval")
        throw new Problem(403, "DELEGATION_APPROVAL_ONLY");
      principal = await authorizeDelegation(
        client,
        delegate,
        { taskId: task.id, ownerId: task.principal_id },
        "approve",
      );
    }
    if (delegate)
      requireCapability(principal, delegateCapability ?? "__undeclared__");
    if (wait.capability) requireCapability(principal, wait.capability);
    return principal;
  }
  async expire(): Promise<void> {
    await this.execution.db.transaction(async (client) => {
      const rows = (
        await client.query<{ id: string }>(
          "SELECT t.id FROM tasks t WHERE t.status LIKE 'waiting_%' AND EXISTS(SELECT 1 FROM waits w WHERE w.task_id=t.id AND w.status='pending' AND w.expires_at<=now()) FOR UPDATE OF t SKIP LOCKED LIMIT 50",
        )
      ).rows;
      for (const row of rows) {
        await client.query(
          "UPDATE waits SET status='expired' WHERE task_id=$1 AND status='pending' AND expires_at<=now()",
          [row.id],
        );
        await client.query(
          "UPDATE tasks SET status='failed',error='WAIT_EXPIRED',updated_at=now() WHERE id=$1",
          [row.id],
        );
        await event(client, row.id, "wait.expired");
      }
    });
  }
}
