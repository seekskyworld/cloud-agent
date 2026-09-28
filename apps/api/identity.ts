import { managementEndpoints as endpoints } from "../../packages/api/management.js";
/** 身份和委托生命周期共用当前认证，不接受客户端声明的工作区或所有者。 */
import type { FastifyInstance } from "fastify";
import type { Container } from "../container.js";
import { Id, Key } from "../../packages/api/contracts.js";
export function registerIdentityRoutes(api: FastifyInstance, c: Container) {
  api.get("/tokens", (req) => c.tokens.list(req.principal));
  api.post("/tokens", (req) => {
    const value = endpoints.createToken.body.parse(req.body);
    return c.tokens.create(req.principal, value.name, value.days);
  });
  api.delete("/tokens/:id", async (req) => {
    await c.tokens.revoke(req.principal, Id.parse(req.params).id);
    return { ok: true };
  });
  api.post("/tasks/:id/delegations", (req) => {
    const value = endpoints.grantDelegation.body.parse(req.body);
    return c.delegations.grant(
      req.principal,
      Id.parse(req.params).id,
      value.delegate,
      value.actions,
      value.hours,
      value.reason,
    );
  });
  api.delete("/delegations/:id", async (req) => {
    await c.delegations.revoke(req.principal, Id.parse(req.params).id);
    return { ok: true };
  });
  api.get("/delegated/tasks/:id", (req) =>
    c.service.delegatedDetail(req.principal, Id.parse(req.params).id),
  );
  api.post("/delegated/tasks/:id/approval", async (req) => {
    const body = endpoints.delegatedApproval.body.parse(req.body);
    await c.service.delegatedApprove(
      req.principal,
      Id.parse(req.params).id,
      body.waitId,
      { approved: body.approved },
      Key.parse(req.headers["idempotency-key"]),
    );
    return { ok: true };
  });
}
