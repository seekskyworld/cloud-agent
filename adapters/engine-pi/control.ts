/** 可选 managed-v1 网关协议；必须显式确认支持，不将关闭 HTTP 当作供应商已停止。 */
import { z } from "zod";
import type {
  ModelControl,
  ModelInvocation,
  ModelReceipt,
} from "../../packages/contracts/model-lifecycle.js";
import { Problem } from "../../packages/contracts/index.js";
const Receipt = z.object({
  state: z.enum([
    "running",
    "unknown",
    "transport_closed",
    "not_started",
    "completed",
  ]),
  usage: z
    .object({
      costUsd: z.number().finite().nonnegative(),
      estimated: z.boolean(),
      complete: z.boolean(),
    })
    .optional(),
});
export interface ManagedGateway {
  scope: string;
}
export function managedHeaders(
  config: ManagedGateway,
  invocation: ModelInvocation,
) {
  return {
    "X-Cloud-Agent-Protocol": "managed-v1",
    "X-Cloud-Agent-Scope": config.scope,
    "X-Cloud-Agent-Request-ID": invocation.id,
    "X-Cloud-Agent-Deadline": String(invocation.deadlineAt),
  };
}
export function verifyManagedResponse(response: Response, id: string) {
  if (
    response.ok &&
    (response.headers.get("x-cloud-agent-protocol") !== "managed-v1" ||
      response.headers.get("x-cloud-agent-request-id") !== id)
  )
    throw new Problem(502, "MODEL_CONTROL_NOT_ACKNOWLEDGED");
}
export function gatewayControl(
  resolve: (
    signal: AbortSignal,
  ) => Promise<{ baseUrl: string; apiKey: string }>,
  config: ManagedGateway,
): ModelControl {
  const request = async (
    invocation: ModelInvocation,
    signal: AbortSignal,
    method: string,
  ): Promise<ModelReceipt> => {
    const { baseUrl, apiKey } = await resolve(signal);
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/model-requests/${encodeURIComponent(invocation.id)}`,
      {
        method,
        signal,
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "X-Cloud-Agent-Scope": config.scope,
        },
      },
    );
    if (response.status === 404) return { state: "unknown" };
    if (!response.ok) throw new Problem(502, "MODEL_CONTROL_UNAVAILABLE");
    return Receipt.parse(await response.json());
  };
  return {
    cancel: (ref, signal) => request(ref, signal, "DELETE"),
    status: (ref, signal) => request(ref, signal, "GET"),
  };
}
