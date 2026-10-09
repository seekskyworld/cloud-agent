import type {
  Data,
  Principal,
  Step,
  Task,
  Json,
  Action,
  Tool,
  Outcome,
} from "../contracts/index.js";
export type TaskPageRow = Task & { cursor_at: string };
export interface TaskNotification {
  task: Task;
  key: string;
  waitId: string | null;
  reason: string;
  schema: Json;
}
export interface TaskArtifact {
  task_id: string;
  title: string;
  content: unknown;
  media_type: string;
}
export interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
}
export interface MessageRow {
  id: string;
  task_id: string | null;
  role: string;
  content: Json;
  created_at: Date;
}
export interface TaskEvent {
  id: string;
  type: string;
  data: Json;
  created_at: string | Date;
}
export interface TaskDetail {
  task: Task;
  steps: Pick<Step, "id" | "key" | "kind" | "status" | "attempts" | "output">[];
  waits: {
    id: string;
    kind: string;
    reason: string;
    schema: Json;
    status: string;
    response: Json | null;
    expires_at: Date;
  }[];
  artifacts: {
    id: string;
    title: string;
    media_type: string;
    created_at: Date;
  }[];
  invocations: {
    id: string;
    tool_name: string;
    effect: string;
    status: string;
    receipt: string | null;
    reconciliation_ref: string | null;
  }[];
  files: {
    id: string;
    name: string;
    media_type: string;
    bytes: number;
    digest: string;
  }[];
  modelRequests: {
    id: string;
    state: string;
    remote_state: string;
    quarantine_until: Date;
    cost_usd: number | null;
    usage_complete: boolean;
  }[];
}

/** Application-facing task port. Implementations may use PostgreSQL, but callers never receive its client. */
export interface TaskPort {
  workspaceTask(workspace: string, id: string): Promise<Task>;
  children(id: string): Promise<Task[]>;
  steps(taskId: string): Promise<Step[]>;
  artifact(id: string): Promise<TaskArtifact | undefined>;
  conversations(principal: Principal): Promise<ConversationRow[]>;
  conversationTasks(principal: Principal, id: string): Promise<Task[]>;
  conversationMessages(id: string): Promise<MessageRow[]>;
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
  ): Promise<TaskNotification | null>;
  get(principal: Principal, id: string): Promise<Task>;
  list(principal: Principal, offset?: number): Promise<Task[]>;
  page(
    principal: Principal,
    cursor?: { time: string; id: string },
  ): Promise<TaskPageRow[]>;
  detail(principal: Principal, id: string): Promise<TaskDetail>;
  events(principal: Principal, id: string, after: string): Promise<TaskEvent[]>;
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

/** 粗粒度执行端口保留租约、结果和事件同事务提交，不拆成通用 CRUD。 */
export interface ExecutionPort {
  readonly leaseMs: number;
  readonly modelRequests: import("./model-ledger.js").ModelLedger;
  watchCancellation(token: string, callback: () => void): Promise<() => void>;
  reconnectCancellation(): Promise<void>;
  claim(engineId: string | ((task: Task) => string)): Promise<Task | undefined>;
  heartbeat(task: Task): Promise<boolean>;
  steps(taskId: string): Promise<Step[]>;
  prepare(
    task: Task,
    action: Exclude<Action, { kind: "complete" }>,
    tool?: Tool,
  ): Promise<Step>;
  begin(task: Task, step: Step): Promise<void>;
  checkpointModel(
    task: Task,
    step: Step,
    output: Json,
    hash: string,
    elapsed: number,
    cost: number,
  ): Promise<void>;
  resumeCheckpoint(task: Task, step: Step, hash: string): Promise<boolean>;
  invalidateCheckpoint(task: Task, step: Step): Promise<Task>;
  finish(
    task: Task,
    step: Step,
    outcome: Outcome,
    elapsed: number,
    cost?: number,
  ): Promise<void>;
  fail(task: Task, code: string): Promise<void>;
  complete(task: Task, result: Json, title: string): Promise<void>;
}
export interface ExecutionWaitPort {
  suspend(
    task: Task,
    step: Step,
    action: Extract<Action, { kind: "wait" }>,
  ): Promise<boolean>;
}
export interface TaskGroupPort {
  spawn(
    task: Task,
    step: Step,
    action: Extract<Action, { kind: "children" }>,
    principal: Principal,
  ): Promise<void>;
}
