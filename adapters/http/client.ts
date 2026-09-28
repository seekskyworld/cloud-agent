import {
  ExecutionFailure,
  retryAfter,
} from "../../packages/contracts/failure.js";
/** 固定服务地址和逐用户凭据；禁止重定向携带认证信息到其他主机。 */
import {
  Problem,
  type Data,
  type ExecutionContext,
  type Json,
} from "../../packages/contracts/index.js";
import { Connections, bearer } from "../../packages/connections/index.js";
export type CredentialMap = Record<
  string,
  Record<string, Record<string, string>>
>;
export class DomainHttp {
  constructor(
    private service: string,
    private baseUrl: string,
    private credentials: CredentialMap | Connections,
  ) {}
  async json(
    path: string,
    context: ExecutionContext,
    body?: Data,
  ): Promise<Json> {
    const response = await this.request(path, context, body);
    if (response.status < 200 || response.status >= 300)
      throw new ExecutionFailure(
        response.status === 429
          ? "rate_limited"
          : [401, 403].includes(response.status)
            ? "authorization"
            : response.status < 500
              ? "permanent"
              : "transient",
        "UPSTREAM_REJECTED",
        { retryAfterMs: response.retryAfterMs },
      );
    return response.data;
  }
  async request(
    path: string,
    context: ExecutionContext,
    body?: Data,
  ): Promise<{ status: number; data: Json; retryAfterMs?: number }> {
    const resolved =
      this.credentials instanceof Connections
        ? await this.credentials.resolve(
            this.service,
            context.principal,
            context.signal,
          )
        : undefined;
    const token = resolved
      ? bearer(resolved.secret)
      : (this.credentials as CredentialMap)[context.principal.workspace_id]?.[
          context.principal.id
        ]?.[this.service];
    if (typeof token !== "string" || !token)
      throw new Problem(403, "DOMAIN_IDENTITY_NOT_CONFIGURED");
    const baseUrl = resolved?.endpoint ?? this.baseUrl;
    // 相对路径只在固定连接主机内使用，禁止调用方改变目标。
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new Problem(400, "DOMAIN_PATH_INVALID");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(body ? { "idempotency-key": context.idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: context.signal,
      redirect: "error",
    });
    const delay = retryAfter(response.headers.get("retry-after"));
    return {
      status: response.status,
      data: await responseData(response),
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    };
  }
}
async function responseData(response: Response): Promise<Json> {
  // 不信任 Content-Length；按读取字节数限制远端结果。
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        throw new Problem(502, "DOMAIN_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Json;
  } catch (error) {
    if (response.ok) throw error;
    return null;
  }
}
