/** 可选中立接入示例：真实外部查询、文件产物与等待确认，均复用受控工具执行。 */
import { z } from "zod";
import {
  Problem,
  type Module,
  type Tool,
} from "../../packages/contracts/index.js";
import type { Connections } from "../../packages/connections/index.js";
import type { ArtifactFiles } from "../../packages/artifacts/index.js";
import { DomainHttp } from "../../adapters/http/client.js";
export interface ExampleServices {
  examples?: boolean;
  connections?: Connections;
  files?: ArtifactFiles;
}
export function integrationExamples(services: ExampleServices = {}): Module[] {
  const query: Tool = {
    name: "example.lookup",
    version: "1.0.0",
    description: "读取可信 example-api 连接",
    input: z.object({ path: z.string().startsWith("/") }).strict(),
    output: z.record(z.string(), z.json()),
    capability: "example:query",
    effect: "read",
    timeoutMs: 10000,
    async execute(input, context) {
      if (!services.connections)
        throw new Problem(503, "EXAMPLE_CONNECTION_REQUIRED");
      const response = await new DomainHttp(
        "example-api",
        "",
        services.connections,
      ).request(String(input.path), context);
      return response.status >= 200 && response.status < 300
        ? { kind: "succeeded", output: { data: response.data } }
        : { kind: "failed", code: "UPSTREAM_REJECTED", message: "查询被拒绝" };
    },
  };
  const file: Tool = {
    name: "example.file",
    version: "1.0.0",
    description: "生成 UTF-8 文本文件",
    input: z.object({ text: z.string().min(1).max(40000) }).strict(),
    output: z.record(z.string(), z.json()),
    capability: "example:file",
    effect: "idempotent_write",
    timeoutMs: 20000,
    async execute(input, context) {
      if (!services.files) throw new Problem(503, "ARTIFACT_STORE_DISABLED");
      return {
        kind: "succeeded",
        output: await services.files.put(
          context,
          "result.txt",
          "text/plain",
          Buffer.from(String(input.text)),
        ),
      };
    },
  };
  const queryModule: Module = {
    id: "api-query",
    version: "1.0.0",
    title: "外部 API 查询",
    description: "通过授权连接读取 JSON",
    capability: "example:query",
    input: query.input,
    example: { path: "/status" },
    tools: [query],
    runtime: {
      model: false,
      config: {
        connection:
          (services.connections?.definitions.find(
            (c) => c.id === "example-api",
          ) as unknown as import("../../packages/contracts/index.js").Json) ??
          null,
      },
    },
    next(input, steps) {
      const done = steps.find((s) => s.key === "query");
      return done
        ? { kind: "complete", result: done.output }
        : { kind: "tool", key: "query", name: query.name, input };
    },
  };
  const fileModule: Module = {
    id: "file-report",
    version: "1.0.0",
    title: "生成文件",
    description: "生成可鉴权下载的文本产物",
    capability: "example:file",
    input: file.input,
    example: { text: "Hello Cloud Agent" },
    tools: [file],
    runtime: {
      model: false,
      config: { store: services.files?.store.id ?? null },
    },
    next(input, steps) {
      const done = steps.find((s) => s.key === "file");
      return done
        ? { kind: "complete", result: done.output }
        : { kind: "tool", key: "file", name: file.name, input };
    },
  };
  const approval: Module = {
    id: "message-review",
    version: "1.0.0",
    title: "消息确认",
    description: "通用渠道或 HTTP 补充并确认后完成",
    capability: "example:review",
    input: z.object({ text: z.string().min(1) }).strict(),
    example: { text: "请确认本次请求" },
    tools: [],
    runtime: { model: false },
    next(input, steps) {
      const wait = steps.find((s) => s.key === "review");
      if (!wait)
        return {
          kind: "wait",
          key: "review",
          waitKind: "approval",
          reason: String(input.text),
          schema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
            additionalProperties: false,
          },
          expiresInMs: 3600000,
        };
      return {
        kind: "complete",
        result: { text: input.text!, approved: true },
      };
    },
  };
  return [queryModule, fileModule, approval];
}
