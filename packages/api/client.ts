import { managementEndpoints } from "./management.js";
/** 相同业务动作复用调用方的请求键；不自动重发副作用、不把 Token 放入 URL。 */
import { z } from "zod";
import { endpoints, Id, Key } from "./contracts.js";
export type { Agent, Detail, TaskSummary, Me } from "./contracts.js";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class CloudAgentClient {
  constructor(
    private options: {
      baseUrl?: string;
      token?: () => string;
      fetch?: typeof fetch;
    } = {},
  ) {}
  private async send(path: string, init: RequestInit = {}) {
    const token = this.options.token?.();
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl ?? ""}/v1${path}`,
      {
        ...init,
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const value = z
        .object({ error: z.string(), message: z.string().optional() })
        .safeParse(body);
      throw new ApiError(
        response.status,
        value.success
          ? (value.data.message ?? value.data.error)
          : `HTTP_${response.status}`,
      );
    }
    return response;
  }
  /** 业务扩展接口仍通过同一认证通道；写请求显式提供稳定请求键。 */
  async business<T>(
    packageId: string,
    routeId: string,
    schema: z.ZodType<T>,
    options: { method?: "GET" | "POST"; input?: unknown; key?: string } = {},
  ): Promise<T> {
    for (const id of [packageId, routeId])
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
        throw new Error("BUSINESS_ROUTE_INVALID");
    const method = options.method ?? "GET";
    let path = `/business/${packageId}/${routeId}`;
    if (method === "GET" && options.input)
      path += `?${new URLSearchParams(options.input as Record<string, string>)}`;
    const response = await this.send(path, {
      method,
      ...(method === "POST"
        ? {
            body: JSON.stringify(options.input),
            headers: { "idempotency-key": Key.parse(options.key) },
          }
        : {}),
    });
    return schema.parse(await response.json());
  }
  async call<K extends keyof typeof endpoints>(
    operation: K,
    body: z.input<(typeof endpoints)[K]["body"]>,
    options: {
      id?: string;
      key?: string;
      offset?: number;
      after?: string;
    } = {},
  ): Promise<z.output<(typeof endpoints)[K]["response"]>> {
    const definition = endpoints[operation];
    const parsed = definition.body.parse(body);
    let path: string = definition.path;
    if (path.includes("{id}"))
      path = path.replace("{id}", Id.parse({ id: options.id }).id);
    if (operation === "tasks")
      path += `?offset=${z
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(options.offset ?? 0)}`;
    if (operation === "events")
      path += `?format=json&after=${z
        .string()
        .regex(/^\d{1,18}$/)
        .parse(options.after ?? "0")}`;
    const response = await this.send(path, {
      method: definition.method,
      body: parsed === undefined ? undefined : JSON.stringify(parsed),
      headers:
        "key" in definition
          ? { "idempotency-key": Key.parse(options.key) }
          : {},
    });
    return definition.response.parse(await response.json()) as z.output<
      (typeof endpoints)[K]["response"]
    >;
  }
  async management<K extends keyof typeof managementEndpoints>(
    operation: K,
    body: z.input<(typeof managementEndpoints)[K]["body"]>,
    options: { id?: string; key?: string; query?: Record<string, string> } = {},
  ): Promise<z.output<(typeof managementEndpoints)[K]["response"]>> {
    const definition = managementEndpoints[operation];
    let path: string = definition.path;
    if (path.includes("{id}"))
      path = path.replace(
        "{id}",
        encodeURIComponent(z.string().min(1).max(120).parse(options.id)),
      );
    if (options.query) path += `?${new URLSearchParams(options.query)}`;
    const value = definition.body.parse(body);
    const response = await this.send(path, {
      method: definition.method,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      headers: definition.key
        ? { "idempotency-key": Key.parse(options.key) }
        : {},
    });
    return definition.response.parse(await response.json()) as z.output<
      (typeof managementEndpoints)[K]["response"]
    >;
  }
  async downloadFile(id: string): Promise<Blob> {
    return (await this.send(`/files/${Id.parse({ id }).id}`)).blob();
  }
}
