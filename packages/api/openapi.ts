import { managementEndpoints } from "./management.js";
/** 合并核心、管理与已启用业务路由；供应商回调和公开/登录入口另行说明。 */
import { z } from "zod";
import { endpoints } from "./contracts.js";
export function openapi(
  authMode: "none" | "token",
  business: {
    id: string;
    routes: {
      id: string;
      method: "GET" | "POST";
      input: z.ZodType;
      output: z.ZodType;
    }[];
  }[] = [],
) {
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [id, definition] of Object.entries({
    ...endpoints,
    ...managementEndpoints,
  })) {
    const parameters: object[] = [];
    if (definition.path.includes("{id}"))
      parameters.push({
        in: "path",
        name: "id",
        required: true,
        schema: definition.path.startsWith("/admin/")
          ? { type: "string" }
          : { type: "string", format: "uuid" },
      });
    if ("key" in definition && definition.key)
      parameters.push({
        in: "header",
        name: "idempotency-key",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 180 },
      });
    if (id === "tasks")
      parameters.push({
        in: "query",
        name: "offset",
        schema: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
      });
    if (id === "events")
      parameters.push(
        {
          in: "query",
          name: "after",
          schema: { type: "string", pattern: "^\\d{1,18}$", default: "0" },
        },
        {
          in: "query",
          name: "format",
          schema: { type: "string", enum: ["json", "sse"], default: "sse" },
        },
      );
    const json = {
      "application/json": {
        schema: componentSchema(
          `${id}Response`,
          definition.response,
          schemas,
          "input",
        ),
      },
    };
    const content =
      id === "events"
        ? { ...json, "text/event-stream": { schema: { type: "string" } } }
        : json;
    const path = `/v1${definition.path}`;
    paths[path] ??= {};
    paths[path][definition.method.toLowerCase()] = {
      operationId: id,
      parameters,
      ...(definition.method === "POST"
        ? {
            requestBody: {
              required: id !== "cancel" && id !== "retry",
              content: {
                "application/json": {
                  schema: componentSchema(
                    `${id}Request`,
                    definition.body,
                    schemas,
                    "output",
                  ),
                },
              },
            },
          }
        : {}),
      responses: {
        ["status" in definition ? Number(definition.status) : 200]: {
          description: "Success",
          content,
        },
        default: {
          description: "Error",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["error"],
                properties: {
                  error: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    };
  }
  paths["/v1/files/{id}"] = {
    get: {
      operationId: "downloadFile",
      parameters: [
        {
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Authorized attachment",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
      },
    },
  };
  for (const entry of business)
    for (const route of entry.routes) {
      const name = `${entry.id}_${route.id}`;
      paths[`/v1/business/${entry.id}/${route.id}`] = {
        [route.method.toLowerCase()]: {
          operationId: name,
          ...(route.method === "POST"
            ? {
                parameters: [
                  {
                    in: "header",
                    name: "idempotency-key",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: componentSchema(
                        `${name}Request`,
                        route.input,
                        schemas,
                        "input",
                      ),
                    },
                  },
                },
              }
            : {}),
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: componentSchema(
                    `${name}Response`,
                    route.output,
                    schemas,
                    "output",
                  ),
                },
              },
            },
          },
        },
      };
    }
  paths["/v1/metrics"] = {
    get: {
      operationId: "metrics",
      responses: {
        200: {
          description: "Prometheus metrics",
          content: { "text/plain": { schema: { type: "string" } } },
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Cloud Agent public API",
      version: "1.0.0",
      description:
        "Task, business and administration API. Provider webhooks are documented separately.",
    },
    security: authMode === "token" ? [{ bearer: [] }] : [],
    components: {
      schemas,
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    paths,
  };
}

/** 内嵌 JSON Schema 的根引用必须重定位到对应组件，不能误指 OpenAPI 文档根。 */
function componentSchema(
  name: string,
  type: z.ZodType,
  schemas: Record<string, unknown>,
  io: "input" | "output",
) {
  const prefix = `#/components/schemas/${name}`;
  const value = JSON.parse(
    JSON.stringify(z.toJSONSchema(type, { io }), (key, value: unknown) =>
      key === "$ref" && typeof value === "string" && value.startsWith("#")
        ? prefix + value.slice(1)
        : value,
    ),
  ) as unknown;
  schemas[name] = value;
  return { $ref: prefix };
}
