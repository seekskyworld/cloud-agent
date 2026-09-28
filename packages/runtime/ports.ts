import type { Data, Principal, Step, Task } from "../contracts/index.js";
type Store = import("../persistence/tasks.js").TaskStore;

export type TaskPageRow = Task & { cursor_at: string };
export type TaskNotification =
  Awaited<ReturnType<Store["notification"]>> extends infer R
    ? Exclude<R, null>
    : never;
export type TaskDetail = Awaited<ReturnType<Store["detail"]>>;

/** Application-facing task port. Implementations may use PostgreSQL, but callers never receive its client. */
export interface TaskPort {
  workspaceTask(workspace: string, id: string): Promise<Task>;
  children(id: string): Promise<Task[]>;
  steps(taskId: string): Promise<Step[]>;
  artifact(id: string): ReturnType<Store["artifact"]>;
  conversations(principal: Principal): ReturnType<Store["conversations"]>;
  conversationTasks(principal: Principal, id: string): Promise<Task[]>;
  conversationMessages(id: string): ReturnType<Store["conversationMessages"]>;
  create(
    principal: Principal,
    moduleId: string,
    input: Data,
    key: string,
    conversationId?: string,
  ): Promise<Task>;
  conversationFor(
    principal: Principal,
    namespace: string,
    key: string,
    title: string,
  ): Promise<string>;
  waitTask(waitId: string): Promise<string>;
  notification(
    principal: Principal,
    id: string,
  ): ReturnType<Store["notification"]>;
  get(principal: Principal, id: string): Promise<Task>;
  list(principal: Principal, offset?: number): Promise<Task[]>;
  page(
    principal: Principal,
    cursor?: { time: string; id: string },
  ): Promise<TaskPageRow[]>;
  detail(principal: Principal, id: string): ReturnType<Store["detail"]>;
  events(
    principal: Principal,
    id: string,
    after: string,
  ): ReturnType<Store["events"]>;
  cancel(principal: Principal, id: string): Promise<void>;
  retry(principal: Principal, id: string): Promise<void>;
}

export interface WaitPort {
  respond(
    principal: Principal,
    waitId: string,
    response: Data,
    key: string,
    expectedTask?: string,
    delegate?: Principal,
    delegateCapability?: string,
  ): Promise<void>;
}

export interface SignalPort {
  receive(
    principal: Principal,
    id: string,
    key: string,
    response: Data,
    eventKey: string,
  ): Promise<void>;
}

export interface IdentityPort {
  current(workspace: string, id: string): Promise<Principal>;
}

export interface ModuleCatalogPort {
  get(id: string, version?: string): import("../contracts/index.js").Module;
  list(): import("../contracts/index.js").Module[];
  accepts(task: {
    module_id: string;
    module_version: string;
    config_hash: string;
  }): boolean;
}

export interface ToolExecutionPort {
  execute(
    tool: import("../contracts/index.js").Tool,
    input: Data,
    context: import("../contracts/index.js").ExecutionContext,
    step: Step,
  ): Promise<import("../contracts/index.js").Outcome>;
}
