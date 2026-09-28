/** MCP 作为受控工具适配器；权限/副作用由本地清单声明，不信任远端描述赋权。 */
import { z } from "zod";
import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { Connections, bearer } from "../../packages/connections/index.js";
import {
  canonical,
  type Tool,
  type Data,
  type Json,
  type ExecutionContext,
} from "../../packages/contracts/index.js";
import { ExecutionFailure } from "../../packages/contracts/failure.js";
export interface McpToolMapping {
  name: string;
  remoteName: string;
  version: string;
  capability: string;
  effect: "read" | "unsafe_write";
  approval?: boolean;
  inputSchema: Json;
  outputSchema: Json;
}
export interface McpConfig {
  connection: string;
  tools: McpToolMapping[];
}
export function mcpTools(connections: Connections, config: McpConfig): Tool[] {
  if (new Set(config.tools.map((t) => t.name)).size !== config.tools.length)
    throw new Error("MCP_TOOL_DUPLICATE");
  return config.tools.map((mapping) => {
    const ajv = new Ajv({ strict: false });
    const input = ajv.compile(mapping.inputSchema as object),
      output = ajv.compile(mapping.outputSchema as object);
    return {
      name: mapping.name,
      version: mapping.version,
      description: `MCP ${mapping.remoteName}`,
      capability: mapping.capability,
      effect: mapping.effect,
      approval: mapping.approval,
      timeoutMs: 30_000,
      input: z
        .fromJSONSchema(mapping.inputSchema as z.core.JSONSchema.JSONSchema)
        .refine((value) => input(value)),
      output: z.json().refine((value) => output(value)),
      execute: async (value, context) => ({
        kind: "succeeded",
        output: await invoke(
          connections,
          config.connection,
          mapping,
          value,
          context,
        ),
      }),
    };
  });
}
async function invoke(
  connections: Connections,
  id: string,
  mapping: McpToolMapping,
  input: Data,
  context: ExecutionContext,
): Promise<Json> {
  const connection = await connections.resolve(
    id,
    context.principal,
    context.signal,
  );
  let session: string | null = null;
  const request = async (
    method: string,
    params: unknown,
    notification = false,
  ): Promise<unknown> => {
    const requestId = notification ? undefined : randomUUID();
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer(connection.secret)}`,
        "MCP-Protocol-Version": "2025-03-26",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: requestId }),
        method,
        params,
      }),
      signal: context.signal,
    });
    session = response.headers.get("mcp-session-id") ?? session;
    if (!response.ok)
      throw new ExecutionFailure("transient", "MCP_HTTP_FAILED");
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    const raw = await rpcBody(response, context.signal, requestId!);
    const parsed = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(requestId!),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(raw);
    if (parsed.error !== undefined)
      throw new ExecutionFailure("unknown", "MCP_RPC_FAILED");
    return parsed.result;
  };
  try {
    const initialized = z.object({ protocolVersion: z.string() }).parse(
      await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "cloud-agent", version: "1" },
      }),
    );
    if (initialized.protocolVersion !== "2025-03-26")
      throw new ExecutionFailure("permanent", "MCP_VERSION_UNSUPPORTED", {
        notAccepted: true,
      });
    await request("notifications/initialized", {}, true);
    const listed = z
      .object({
        tools: z.array(z.object({ name: z.string(), inputSchema: z.json() })),
        nextCursor: z.string().optional(),
      })
      .parse(await request("tools/list", {}));
    if (listed.nextCursor)
      throw new ExecutionFailure(
        "permanent",
        "MCP_PAGINATED_CATALOG_UNSUPPORTED",
        { notAccepted: true },
      );
    const remote = listed.tools.find((t) => t.name === mapping.remoteName);
    if (
      !remote ||
      canonical(remote.inputSchema) !== canonical(mapping.inputSchema)
    )
      throw new ExecutionFailure("permanent", "MCP_TOOL_SCHEMA_CHANGED", {
        notAccepted: true,
      });
    const result = z
      .object({
        isError: z.boolean().optional(),
        structuredContent: z.json().optional(),
        content: z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .optional(),
      })
      .parse(
        await request("tools/call", {
          name: mapping.remoteName,
          arguments: input,
        }),
      );
    if (result.isError) throw new ExecutionFailure("unknown", "MCP_TOOL_ERROR");
    if (result.structuredContent !== undefined) return result.structuredContent;
    return JSON.parse(
      result.content?.find((c) => c.type === "text")?.text ?? "null",
    ) as Json;
  } finally {
    if (session) {
      // 释放服务端临时会话；清理失败不能改写已经取得的业务回执。
      try {
        const response = await fetch(connection.endpoint, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${bearer(connection.secret)}`,
            "Mcp-Session-Id": session,
            "MCP-Protocol-Version": "2025-03-26",
          },
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
      } catch {
        /* 服务端会话仍由其 TTL 回收。 */
      }
    }
  }
}
async function rpcBody(
  response: Response,
  signal: AbortSignal,
  id: string,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MCP_BODY_REQUIRED");
  const sse = response.headers
      .get("content-type")
      ?.includes("text/event-stream"),
    decoder = new TextDecoder();
  let buffer = "",
    length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) throw new Error("MCP_RESPONSE_TOO_LARGE");
      buffer += decoder.decode(value, { stream: true });
      if (sse) {
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop()!;
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          const message: unknown = JSON.parse(data);
          if (
            message &&
            typeof message === "object" &&
            "id" in message &&
            message.id === id
          )
            return message;
        }
      }
    }
    if (sse) throw new Error("MCP_RESPONSE_MISSING");
    return JSON.parse(buffer + decoder.decode());
  } finally {
    await reader.cancel();
  }
}
