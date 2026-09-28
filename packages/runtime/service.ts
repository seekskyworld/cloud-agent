import { z } from "zod";
import type { PolicyPort } from "../identity/delegation.js";
import { bounded } from "../contracts/lifecycle.js";
import type { ReconciliationInput } from "../contracts/reconciliation.js";
/** 用户操作服务统一复核当前模块权限及领域证据的可见性。 */
import {
  Problem,
  requireCapability,
  type Principal,
  type Task,
  type Data,
} from "../contracts/index.js";
import type {
  TaskPort,
  WaitPort,
  SignalPort,
  IdentityPort,
  ModuleCatalogPort,
} from "./ports.js";
export interface ReconciliationPort {
  resolve(
    principal: Principal,
    taskId: string,
    key: string,
    input: ReconciliationInput,
  ): Promise<void>;
}
export class TaskService {
  constructor(
    readonly tasks: TaskPort,
    private registry: ModuleCatalogPort,
    private identity: IdentityPort,
    private waits: WaitPort,
    private signals: SignalPort,
    private contexts?: import("../context/index.js").ContextManager,
    private delegations?: PolicyPort,
    private reconciliation?: ReconciliationPort,
  ) {}
  current(principal: Principal) {
    return this.identity.current(principal.workspace_id, principal.id);
  }
  async create(
    principal: Principal,
    moduleId: string,
    input: Data,
    key: string,
    conversationId?: string,
  ) {
    return this.tasks.create(
      await this.current(principal),
      moduleId,
      input,
      key,
      conversationId,
    );
  }
  async get(principal: Principal, id: string) {
    principal = await this.current(principal);
    const task = await this.tasks.get(principal, id);
    await this.authorize(principal, task);
    return task;
  }
  async respond(
    principal: Principal,
    waitId: string,
    response: Data,
    key: string,
    expectedTask?: string,
  ) {
    principal = await this.current(principal);
    const id = await this.tasks.waitTask(waitId);
    if (expectedTask && id !== expectedTask)
      throw new Problem(404, "WAIT_NOT_FOUND");
    await this.get(principal, id);
    return this.waits.respond(principal, waitId, response, key, id);
  }
  /** 所有者撤权后仍可停止任务，取消不要求恢复执行或读取结果的能力。 */
  async cancel(principal: Principal, id: string) {
    return this.tasks.cancel(await this.current(principal), id);
  }
  async retry(principal: Principal, id: string) {
    principal = await this.current(principal);
    await this.get(principal, id);
    return this.tasks.retry(principal, id);
  }
  async reconcile(
    principal: Principal,
    id: string,
    key: string,
    input: ReconciliationInput,
  ) {
    principal = await this.current(principal);
    await this.get(principal, id);
    if (!this.reconciliation)
      throw new Problem(503, "RECONCILIATION_UNAVAILABLE");
    return this.reconciliation.resolve(principal, id, key, input);
  }
  async signal(
    principal: Principal,
    id: string,
    key: string,
    response: Data,
    eventKey: string,
  ) {
    principal = await this.current(principal);
    await this.get(principal, id);
    return this.signals.receive(principal, id, key, response, eventKey);
  }
  async conversationFor(
    principal: Principal,
    namespace: string,
    key: string,
    title: string,
  ) {
    return this.tasks.conversationFor(
      await this.current(principal),
      namespace,
      key,
      title,
    );
  }
  /** 通道只获得稳定通知标识；授权失败时不返回输入、结果或等待内容。 */
  async notification(principal: Principal, id: string) {
    const notice = await this.tasks.notification(principal, id);
    if (!notice) return null;
    try {
      await this.authorize(principal, notice.task);
      return {
        ...notice,
        status: notice.task.status,
        error: null as string | null,
      };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return {
        ...notice,
        task: null,
        status: notice.task.status,
        reason: "",
        schema: {},
        error: error.code,
      };
    }
  }
  async events(principal: Principal, id: string, after: string) {
    principal = await this.current(principal);
    await this.get(principal, id);
    return this.tasks.events(principal, id, after);
  }
  async authorize(principal: Principal, task: Task): Promise<void> {
    principal = await this.current(principal);
    if (
      task.workspace_id !== principal.workspace_id ||
      task.principal_id !== principal.id
    )
      throw new Problem(404, "TASK_NOT_FOUND");
    for (const child of await this.tasks.children(task.id))
      await this.authorize(principal, child);
    const module = this.registry.get(task.module_id, task.module_version);
    requireCapability(principal, module.capability);
    await bounded(15_000, async (signal) => {
      await this.contexts?.authorizeTask(task, principal, signal);
      if (module.authorizeRead) {
        const steps = await this.tasks.steps(task.id);
        await module.authorizeRead(task, principal, signal, steps);
      }
    });
  }

  async delegated(actor: Principal, id: string, action: "read" | "approve") {
    actor = await this.current(actor);
    const task = await this.tasks.workspaceTask(actor.workspace_id, id);
    if (!this.delegations) throw new Problem(503, "DELEGATION_UNAVAILABLE");
    const owner = await this.delegations.authorize(
      actor,
      { taskId: id, ownerId: task.principal_id },
      action,
    );
    const module = this.registry.get(task.module_id, task.module_version);
    requireCapability(owner, module.capability);
    await this.authorize(owner, task);
    await bounded(15_000, async (signal) => {
      await this.contexts?.authorizeTask(
        { ...task, principal_id: actor.id },
        actor,
        signal,
      );
      if (module.authorizeRead)
        await module.authorizeRead(
          task,
          actor,
          signal,
          await this.tasks.steps(id),
        );
    });
    return { owner, task };
  }
  async delegatedDetail(actor: Principal, id: string) {
    const { owner } = await this.delegated(actor, id, "read");
    return this.tasks.detail(owner, id);
  }
  async delegatedApprove(
    actor: Principal,
    id: string,
    waitId: string,
    response: Data,
    key: string,
  ) {
    const { owner, task } = await this.delegated(actor, id, "approve");
    return this.waits.respond(
      owner,
      waitId,
      response,
      `delegate:${actor.id}:${key}`,
      id,
      actor,
      this.registry.get(task.module_id, task.module_version).capability,
    );
  }
  async detail(principal: Principal, id: string) {
    principal = await this.current(principal);
    const task = await this.tasks.get(principal, id);
    await this.authorize(principal, task);
    return this.tasks.detail(principal, id);
  }
  async list(principal: Principal, offset: number) {
    principal = await this.current(principal);
    const rows = await this.tasks.list(principal, offset);
    return this.summaries(principal, rows);
  }
  private summaries(principal: Principal, rows: Task[]) {
    return rows.flatMap((row) => {
      const module = this.registry
        .list()
        .find(
          (module) =>
            module.id === row.module_id &&
            module.version === row.module_version,
        );
      if (module && !principal.capabilities.includes(module.capability))
        return [];
      // 模块移除后仅返回所属任务的状态摘要；详情仍要求安装模块并通过其读取授权。
      return [
        {
          id: row.id,
          module_id: row.module_id,
          status: row.status,
          created_at: row.created_at,
          error: row.error,
          available: Boolean(module),
          compatibility: this.registry.accepts(row)
            ? "compatible"
            : "requires_compatible_worker",
        },
      ];
    });
  }
  async page(principal: Principal, after?: string) {
    principal = await this.current(principal);
    let cursor: { time: string; id: string } | undefined;
    if (after) {
      try {
        cursor = z
          .object({ time: z.string().max(80), id: z.uuid() })
          .parse(JSON.parse(Buffer.from(after, "base64url").toString()));
      } catch {
        throw new Problem(400, "CURSOR_INVALID");
      }
    }
    const rows = await this.tasks.page(principal, cursor),
      more = rows.length > 50;
    const page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      items: this.summaries(principal, page),
      next:
        more && last
          ? Buffer.from(
              JSON.stringify({ time: last.cursor_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  async artifact(principal: Principal, id: string) {
    principal = await this.current(principal);
    const row = await this.tasks.artifact(id);
    if (!row) throw new Problem(404, "ARTIFACT_NOT_FOUND");
    const task = await this.tasks.get(principal, row.task_id);
    await this.authorize(principal, task);
    return row;
  }
  async conversations(principal: Principal) {
    return this.tasks.conversations(await this.current(principal));
  }
  async conversation(principal: Principal, id: string) {
    principal = await this.current(principal);
    const tasks = await this.tasks.conversationTasks(principal, id);
    for (const task of tasks) await this.authorize(principal, task);
    return this.tasks.conversationMessages(id);
  }
}
