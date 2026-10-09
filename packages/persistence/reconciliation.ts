/** 在任务锁内复核当前身份和步骤版本；确认成功只记录结果，永不重发原调用。 */
import {
  type Principal,
  type Step,
  type Json,
  Problem,
  requireCapability,
} from "../contracts/index.js";
import type { ReconciliationInput } from "../contracts/reconciliation.js";
import { Reconciliation } from "../contracts/reconciliation.js";
import type { Registry } from "../runtime/registry.js";
import { Database } from "./database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { ownedTask, event } from "./task-helpers.js";
export class ReconciliationStore {
  constructor(
    private db: Database,
    private registry: Registry,
  ) {}
  async resolve(
    actor: Principal,
    taskId: string,
    key: string,
    raw: ReconciliationInput,
  ) {
    const input = Reconciliation.parse(raw);
    if (!key || key.length > 180)
      throw new Problem(400, "IDEMPOTENCY_KEY_INVALID");
    await this.db.transaction(async (client) => {
      const principal = (
        await client.query<Principal>(
          "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
          [actor.workspace_id, actor.id],
        )
      ).rows[0];
      if (!principal) throw new Problem(403, "IDENTITY_REVOKED");
      requireCapability(principal, "task:reconcile");
      const task = await ownedTask(client, principal, taskId, true);
      const module = this.registry.get(task.module_id, task.module_version);
      requireCapability(principal, module.capability);
      if (!this.registry.accepts(task))
        throw new Problem(409, "MODULE_VERSION_CHANGED");
      const hash = fingerprint(input);
      const previous = (
        await client.query<{ request_hash: string }>(
          "SELECT request_hash FROM task_reconciliations WHERE task_id=$1 AND command_key=$2",
          [taskId, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new Problem(409, "IDEMPOTENCY_CONFLICT");
        return;
      }
      if (task.status !== "waiting_external" || task.lease_token)
        throw new Problem(409, "TASK_NOT_RECONCILABLE");
      const step = (
        await client.query<Step>(
          "SELECT * FROM steps WHERE id=$1 AND task_id=$2 FOR UPDATE",
          [input.stepId, taskId],
        )
      ).rows[0];
      if (
        !step ||
        step.status !== "unknown" ||
        step.attempts !== input.expectedAttempts ||
        step.request.kind !== "tool"
      )
        throw new Problem(409, "STEP_NOT_RECONCILABLE");
      const action = step.request;
      const tool = module.tools.find((t) => t.name === action.name);
      if (!tool) throw new Problem(409, "TOOL_NOT_ALLOWED");
      requireCapability(principal, tool.capability);
      let output: Json = null;
      if (input.decision === "succeeded")
        output = tool.output.parse(input.output) as Json;
      await client.query(
        "INSERT INTO task_reconciliations(task_id,command_key,request_hash,principal_id,step_id,decision,reason,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          taskId,
          key,
          hash,
          principal.id,
          step.id,
          input.decision,
          input.reason,
          input.receipt,
        ],
      );
      if (input.decision === "succeeded") {
        await client.query(
          "UPDATE steps SET status='succeeded',output=$2,updated_at=now() WHERE id=$1",
          [step.id, JSON.stringify(output)],
        );
        await client.query(
          "UPDATE tool_invocations SET status='succeeded',receipt=$2,updated_at=now() WHERE id=$1",
          [step.id, input.receipt],
        );
      }
      await client.query(
        "UPDATE tasks SET status=$2,error=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [taskId, input.decision === "succeeded" ? "queued" : "cancelled"],
      );
      await event(client, taskId, "task.reconciled", {
        stepId: step.id,
        decision: input.decision,
        reason: input.reason,
        receipt: input.receipt,
        actor: principal.id,
      });
    });
  }
}
