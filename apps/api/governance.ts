import { deploymentDiff, revisionId } from "../../packages/deployment/index.js";
/** 运维与可选记忆入口，权限检查在服务端执行。 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Container } from "../container.js";
import { Problem, requireCapability } from "../../packages/contracts/index.js";
import { Id, Key } from "../../packages/api/contracts.js";
import { managementEndpoints } from "../../packages/api/management.js";
export function registerGovernance(api: FastifyInstance, c: Container) {
  api.get("/deployment", async (req) => {
    requireCapability(req.principal, "operations:cluster");
    const manifest = c.registry.deployment(),
      current = await c.deployments.current();
    return {
      id: revisionId(manifest),
      active: current?.id ?? null,
      diff: deploymentDiff(current?.manifest ?? null, manifest),
    };
  });
  api.get("/task-page", (req) =>
    c.service.page(
      req.principal,
      z.object({ after: z.string().max(512).optional() }).parse(req.query)
        .after,
    ),
  );
  api.get("/costs", (req) => {
    requireCapability(req.principal, "operations:read");
    return c.costs.snapshot(req.principal.workspace_id);
  });
  api.get("/costs/pending", (req) => {
    requireCapability(req.principal, "operations:read");
    return c.costs.pending(req.principal.workspace_id);
  });
  api.post("/costs/resolve", async (req) => {
    await c.costs.resolve(
      req.principal,
      Key.parse(req.headers["idempotency-key"]),
      req.body,
    );
    return { ok: true };
  });
  api.get("/business-jobs", (req) => {
    requireCapability(req.principal, "schedule:write");
    return c.businessJobs.list(req.principal.workspace_id);
  });
  api.post("/business-jobs", async (req) => {
    await c.businessJobs.change(
      req.principal,
      Key.parse(req.headers["idempotency-key"]),
      req.body,
    );
    return { ok: true };
  });
  api.post("/memories", (req) => {
    if (!c.config.memoryEnabled) throw new Problem(503, "MEMORY_DISABLED");
    const input = managementEndpoints.memories.body.parse(req.body);
    return c.memories.put(
      req.principal,
      input.namespace,
      input.content,
      input.days,
      Key.parse(req.headers["idempotency-key"]),
    );
  });
  api.delete("/memories/:id", (req) => {
    if (!c.config.memoryEnabled) throw new Problem(503, "MEMORY_DISABLED");
    return c.memories.remove(req.principal, Id.parse(req.params).id);
  });
}
