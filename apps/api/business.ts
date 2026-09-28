/** 业务路由共享平台认证、能力、Schema 和截止约束，响应仅输出声明字段。 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Key } from "../../packages/api/contracts.js";
import type { Container } from "../container.js";
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
}
