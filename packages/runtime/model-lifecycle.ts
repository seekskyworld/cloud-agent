/** 模型调用协调器把远端生命周期与任务提交分开，迟到回执只能更新调用账本。 */
import type {
  ModelEngine,
  ModelRequest,
  ModelTurn,
  Principal,
  Step,
  Task,
  Tool,
} from "../contracts/index.js";
import type {
  ModelReceipt,
  ModelLifecyclePolicy,
} from "../contracts/model-lifecycle.js";
import { ExecutionFailure } from "../contracts/failure.js";
import { abortable, bounded } from "../contracts/lifecycle.js";
import { fingerprint } from "../contracts/fingerprint.js";
import {
  type ModelLedger,
  invocationReference,
  type ModelRequestRow,
} from "./model-ledger.js";
import type { WorkspaceCosts } from "../observability/costs.js";
import { invokeModel } from "./model-request.js";
import { modelDeadline } from "./model-deadline.js";
export function modelPolicy(engine: ModelEngine): ModelLifecyclePolicy {
  const policy = { resourceId: engine.id, ...engine.lifecycle };
  if (!policy.resourceId || policy.resourceId.length > 200)
    throw new Error("MODEL_RESOURCE_INVALID");
  for (const value of [
    policy.concurrency,
    policy.unknownLimit,
    policy.quarantineMs,
    policy.firstOutputTimeoutMs,
    policy.idleTimeoutMs,
  ])
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 1 || value > 86400000)
    )
      throw new Error("MODEL_POLICY_INVALID");
  if (
    (policy.firstOutputTimeoutMs || policy.idleTimeoutMs) &&
    !engine.capabilities?.progress &&
    !engine.stream
  )
    throw new Error("MODEL_PROGRESS_UNSUPPORTED");
  return policy;
}
export class ModelLifecycle {
  constructor(
    readonly store: ModelLedger,
    private costs?: WorkspaceCosts,
  ) {}
  async invoke(input: {
    task: Task;
    step: Step;
    engine: ModelEngine;
    request: ModelRequest;
    tools: Tool[];
    principal: Principal;
    signal: AbortSignal;
    deadlineAt: number;
    begin: () => Promise<void>;
  }) {
    const {
      task,
      step,
      engine,
      request,
      tools,
      principal,
      signal,
      deadlineAt,
    } = input;
    const policy = modelPolicy(engine);
    const row = await this.store.begin(
      task,
      step,
      engine.id,
      policy,
      deadlineAt,
      fingerprint(request),
    );
    let dispatched = false;
    const deadline = modelDeadline(
      signal,
      deadlineAt,
      request.firstOutputTimeoutMs ?? policy.firstOutputTimeoutMs,
      request.idleTimeoutMs ?? policy.idleTimeoutMs,
    );
    try {
      await input.begin();
      await this.costs?.reserve(
        task,
        row.cost_invocation,
        task.budget.maxCostUsd - Number(task.cost_usd),
      );
      deadline.signal.throwIfAborted();
      deadline.start();
      dispatched = true;
      // 异步收尾仍绑定原调用 ID；不能把旧结果提交回已取消或被接管的任务。
      const execution = invokeModel(engine, request, tools, deadline.signal, {
        principal,
        taskId: task.id,
        invocation: invocationReference(row),
        progress: deadline.progress,
        report: (receipt) => this.record(row, receipt),
      }).then(async (value) => {
        await this.completed(row, value);
        return value;
      });
      return await abortable(deadline.signal, () => execution);
    } catch (error) {
      const failure = deadline.failure() ?? error;
      if (
        !dispatched ||
        (failure instanceof ExecutionFailure && failure.options.notAccepted)
      )
        await this.record(row, { state: "not_started" });
      else {
        await this.store.uncertain(row.id);
        await this.control(row, engine, true);
      }
      throw failure;
    } finally {
      deadline.close();
    }
  }
  private async completed(row: ModelRequestRow, value: ModelTurn) {
    await this.record(row, {
      state: "completed",
      usage: {
        costUsd: value.costUsd,
        estimated: value.costEstimated,
        complete: true,
      },
    });
  }
  private async record(row: ModelRequestRow, receipt: ModelReceipt) {
    await this.store.receipt(row.id, receipt);
  }
  private async control(
    row: ModelRequestRow,
    engine: ModelEngine | undefined,
    cancel: boolean,
  ) {
    let receipt: ModelReceipt = { state: "unknown" };
    if (engine?.control) {
      try {
        receipt = await bounded(3000, (s) =>
          cancel
            ? engine.control!.cancel(invocationReference(row), s)
            : engine.control!.status(invocationReference(row), s),
        );
      } catch {
        /* 控制请求失败不能被解释成未执行；数据库收尾失败继续向上抛。 */
      }
    }
    await this.record(row, receipt);
    return receipt;
  }
  async reconcile(resolve: (id: string) => ModelEngine | undefined) {
    for (const row of await this.store.pending()) {
      const engine = resolve(row.engine_id);
      const receipt = await this.control(row, engine, false);
      if (
        !["not_started", "completed"].includes(receipt.state) &&
        engine?.control
      )
        await this.control(row, engine, true);
    }
    await this.store.prune();
  }
}
