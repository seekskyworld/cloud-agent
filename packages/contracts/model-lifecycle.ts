/** 模型远端控制只携带调用元数据；连接、凭据和供应商协议由宿主适配器持有。 */
import type { Principal } from "./index.js";
export interface ModelInvocation {
  id: string;
  operationKey: string;
  deadlineAt: number;
}
export interface ModelCallContext {
  principal: Principal;
  taskId: string;
  invocation?: ModelInvocation;
  /** 只有非空的文本、推理或工具参数增量算进展，传输心跳不算。 */
  progress?: () => void;
  /** 适配器观测到终态或部分用量时记账，不表示业务输出通过校验。 */
  report?: (receipt: ModelReceipt) => Promise<void>;
}
export interface ModelReceipt {
  state:
    | "running"
    | "unknown"
    | "transport_closed"
    | "not_started"
    | "completed";
  usage?: { costUsd: number; estimated: boolean; complete: boolean };
}
export interface ModelControl {
  cancel(
    invocation: ModelInvocation,
    signal: AbortSignal,
  ): Promise<ModelReceipt>;
  status(
    invocation: ModelInvocation,
    signal: AbortSignal,
  ): Promise<ModelReceipt>;
}
export interface ModelLifecyclePolicy {
  /** 相同连接的多个模型配置必须共享此 ID 和策略，不能按任务或用户生成。 */
  resourceId: string;
  concurrency?: number;
  unknownLimit?: number;
  quarantineMs?: number;
  firstOutputTimeoutMs?: number;
  idleTimeoutMs?: number;
}
