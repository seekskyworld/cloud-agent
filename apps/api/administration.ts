/** 管理路由只接受目标身份，不允许客户端指定操作者或工作区。 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdministrationService } from "../../packages/identity/administration.js";
export function registerAdministrationRoutes(
  api: FastifyInstance,
  service: AdministrationService,
) {
  api.get("/admin/catalog", (req) => service.catalog(req.principal));
  api.get("/admin/principals", (req) => {
    const { offset } = z
      .object({
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .strict()
      .parse(req.query);
    return service.members(req.principal, offset);
  });
  api.get("/admin/audit", (req) => {
    const { before } = z
      .object({
        before: z.coerce
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict()
      .parse(req.query);
    return service.audit(req.principal, before);
  });
  api.post("/admin/principals", (req, reply) => {
    reply.header("cache-control", "no-store");
    return service.change(
      req.principal,
      req.body,
      z.string().min(1).max(180).parse(req.headers["idempotency-key"]),
    );
  });
}
