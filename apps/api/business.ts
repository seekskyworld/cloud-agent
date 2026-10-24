/** 业务路由共享平台认证、能力、Schema 和截止约束，响应仅输出声明字段。 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Key } from "../../packages/api/contracts.js";
import { Problem } from "../../packages/contracts/index.js";
import type { BusinessFile } from "../../packages/business/application.js";
import type { Container } from "../container.js";
import { sendFile } from "./files.js";
export function registerBusinessRoutes(
  api: FastifyInstance,
  container: Container,
) {
  api.get("/business", async (req) =>
    container.applications.entries.map((entry) => ({
      id: entry.id,
      pages: (entry.instance.pages ?? []).filter((p) =>
        req.principal.capabilities.includes(p.capability),
      ),
      routes: (entry.instance.routes ?? [])
        .filter((r) => req.principal.capabilities.includes(r.capability))
        .map((r) => ({
          id: r.id,
          method: r.method,
          input: z.toJSONSchema(r.input),
          output: z.toJSONSchema(r.output),
        })),
      files: (entry.instance.files ?? [])
        .filter((r) => req.principal.capabilities.includes(r.capability))
        .map((r) => ({
          id: r.id,
          method: r.method,
          input: z.toJSONSchema(r.input),
        })),
    })),
  );
  for (const entry of container.applications.entries)
    for (const route of entry.instance.routes ?? []) {
      api.route({
        method: route.method,
        url: `/business/${entry.id}/${route.id}`,
        handler: async (req) => {
          const input = route.input.parse(
            route.method === "GET" ? req.query : req.body,
          );
          const key =
            route.method === "POST"
              ? Key.parse(req.headers["idempotency-key"])
              : undefined;
          return container.businessRequests.invoke(
            route,
            entry.id,
            req.principal,
            input,
            key,
          );
        },
      });
    }
  for (const entry of container.applications.entries)
    for (const route of entry.instance.files ?? []) {
      const url = `/business/${entry.id}/files/${route.id}`;
      const options = route.ratePerMinute
        ? {
            config: {
              rateLimit: { max: route.ratePerMinute, timeWindow: 60_000 },
            },
          }
        : {};
      if (route.method === "GET") {
        api.get(url, options, async (req, reply) => {
          const { inline, ...query } = req.query as Record<string, unknown>;
          const input = route.input.parse(query);
          const file = (await container.businessRequests.invokeFile(
            route,
            entry.id,
            req.principal,
            input,
          )) as BusinessFile;
          return sendFile(req, reply, file, inline === "true");
        });
        continue;
      }
      // PUT：只在这个作用域里接收原始字节，体积上限按路由声明。
      const maxBytes = route.maxBytes ?? 50_000_000;
      void api.register(async (scope) => {
        scope.addContentTypeParser(
          "application/octet-stream",
          { parseAs: "buffer", bodyLimit: maxBytes },
          (_request, body, done) => done(null, body),
        );
        scope.put(url, { bodyLimit: maxBytes, ...options }, async (req) => {
          if (!Buffer.isBuffer(req.body))
            throw new Problem(415, "UPLOAD_BODY_REQUIRED");
          return container.businessRequests.invokeFile(
            route,
            entry.id,
            req.principal,
            route.input.parse(req.query),
            Key.parse(req.headers["idempotency-key"]),
            req.body,
          );
        });
      });
    }
}
