/** Token 仅由调用方内存持有，不落入浏览器持久存储或 URL。 */
import { ApiError, CloudAgentClient } from "../../../packages/api/client.js";
export { ApiError };
export const client = (token: string) =>
  new CloudAgentClient({ token: () => token });
export type {
  Agent,
  Detail,
  TaskSummary,
  Me,
} from "../../../packages/api/contracts.js";
export async function request<T>(
  token: string,
  path: string,
  body?: unknown,
  method?: string,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...(body
        ? { "idempotency-key": idempotencyKey ?? crypto.randomUUID() }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.message ?? data.error ?? `请求失败 ${response.status}`,
    );
  return data as T;
}
export const statusLabel: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_input: "等待补充",
  waiting_approval: "等待确认",
  waiting_external: "等待外部结果",
  retry_scheduled: "等待重试",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export type Schedule = {
  id: string;
  module_id: string;
  interval_seconds: number;
  enabled: boolean;
  next_at: string;
};
