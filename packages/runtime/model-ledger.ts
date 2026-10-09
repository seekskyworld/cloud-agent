import type { Task, Step } from "../contracts/index.js";
import type {
  ModelReceipt,
  ModelLifecyclePolicy,
  ModelInvocation,
} from "../contracts/model-lifecycle.js";
export interface ModelRequestRow {
  id: string;
  task_id: string;
  step_id: string;
  engine_id: string;
  resource_id: string;
  operation_key: string;
  cost_invocation: string;
  state: string;
  deadline_at: Date;
  quarantine_until: Date;
}
export function invocationReference(row: ModelRequestRow): ModelInvocation {
  return {
    id: row.id,
    operationKey: row.operation_key,
    deadlineAt: row.deadline_at.getTime(),
  };
}
/** 一次准入/回执各为原子事务；协调器不获得 SQL 客户端。 */
export interface ModelLedger {
  begin(
    task: Task,
    step: Step,
    engineId: string,
    policy: ModelLifecyclePolicy,
    deadlineAt: number,
    requestHash: string,
  ): Promise<ModelRequestRow>;
  uncertain(id: string): Promise<void>;
  receipt(id: string, receipt: ModelReceipt): Promise<boolean>;
  pending(): Promise<ModelRequestRow[]>;
  prune(): Promise<void>;
}
