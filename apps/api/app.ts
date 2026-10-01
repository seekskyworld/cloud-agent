import { registerPublicBusiness } from "./public-business.js";
import { registerGovernance } from "./governance.js";
import { managementEndpoints } from "../../packages/api/management.js";
import { registerIdentityRoutes } from "./identity.js";
import { bounded } from "../../packages/contracts/lifecycle.js";
import { registerBusinessRoutes } from "./business.js";
import { openapi } from "../../packages/api/openapi.js";
import {
  Id,
  Key,
  Create,
  Response,
  InputResponse,
  Signal,
  endpoints,
} from "../../packages/api/contracts.js";
import { Reconciliation } from "../../packages/api/reconciliation.js";
/** HTTP 仅解析请求并调用服务；身份不允许由请求体指定。 */
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../../packages/contracts/index.js";
import type { Container } from "../container.js";
import { administrationPermissions } from "../../packages/identity/administration.js";
import { registerChannelHooks, registerChannelAdmin } from "./channels.js";
import { registerAdministrationRoutes } from "./administration.js";
import { registerMailWebhook, registerMailAdministration } from "./mail.js";
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}
export async function createApp(
  container: Container,
  options: {
    rateLimitMax?: number;
    /** 可信宿主可配置代理地址/网段；默认不信任转发头。 */
    trustedProxies?: string[];
    /** 由可信宿主指定构建目录，测试夹具不覆盖生产页面产物。 */
    staticRoot?: string;
    registerAuthentication?: (
      app: FastifyInstance,
      container: Container,
    ) => Promise<void>;
  } = {},
) {
  const app = Fastify({
    trustProxy: options.trustedProxies ?? false,
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
      level: process.env.LOG_LEVEL ?? "info",
    },
    bodyLimit: 128_000,
  });
  await app.register(rateLimit, {
    max: z
      .number()
      .int()
      .min(1)
      .parse(options.rateLimitMax ?? 120),
    timeWindow: 60_000,
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof Problem)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: "INVALID_REQUEST", message: "请求参数不符合接口要求" });
    app.log.error({ err: error }, "request failed");
    const status =
      error !== null &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    return reply
      .code(status)
      .send({ error: status === 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED" });
  });
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    status: "ok",
  }));
  app.get("/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      const health = await container.operations.ready();
      const business = await container.businessChecks.run("ready");
      return reply
        .code(
          health.worker &&
            health.maintenance &&
            health.compatible &&
            business.ok
            ? 200
            : 503,
        )
        .send({
          ...health,
          ...(business.configured ? { business: business.ok } : {}),
        });
    } catch {
      return reply
        .code(503)
        .send({ database: false, worker: false, maintenance: false });
    }
  });
  app.addHook("preSerialization", async (req, reply, payload) => {
    if (reply.statusCode >= 400 || payload === null) return payload;
    const path = (req.routeOptions.url ?? "").replace(/:([a-zA-Z]+)/g, "{$1}");
    const definition = Object.values({
      ...endpoints,
      ...managementEndpoints,
    }).find((e) => `/v1${e.path}` === path && e.method === req.method);
    if (!definition || typeof payload === "string" || Buffer.isBuffer(payload))
      return payload;
    return definition.response.parse(JSON.parse(JSON.stringify(payload)));
  });
  registerPublicBusiness(app, container.applications);
  if (options.registerAuthentication)
    await app.register((scope) =>
      options.registerAuthentication!(scope, container),
    );
  await registerMailWebhook(app, container.mails);
  await registerChannelHooks(app, container.channels);
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        const reference = await bounded(15_000, (signal) =>
          container.identityProvider.authenticateRequest
            ? container.identityProvider.authenticateRequest(
                {
                  authorization: req.headers.authorization,
                  cookie: req.headers.cookie,
                  origin: req.headers.origin,
                  method: req.method,
                },
                signal,
              )
            : container.identityProvider.authenticate(
                req.headers.authorization,
                signal,
              ),
        );
        req.principal = await container.identity.current(
          reference.workspace,
          reference.principal,
        );
        if (
          container.config.tenantRatePerMinute &&
          !(await container.admission(
            `api:${req.principal.workspace_id}`,
            container.config.tenantRatePerMinute,
          ))
        )
          throw new Problem(429, "WORKSPACE_RATE_LIMIT");
      });
      api.get("/openapi.json", async () =>
        openapi(
          container.config.AUTH_MODE,
          container.applications.entries.map((e) => ({
            id: e.id,
            routes: e.instance.routes ?? [],
          })),
        ),
      );
      api.get("/me", async (req) => ({
        principal: req.principal,
        authMode: container.config.AUTH_MODE,
        engine: container.engine.id,
        administration: administrationPermissions(req.principal.role),
      }));
      registerBusinessRoutes(api, container);
      registerIdentityRoutes(api, container);
      registerGovernance(api, container);
      registerAdministrationRoutes(api, container.administration);
      registerMailAdministration(api, container.mails);
      registerChannelAdmin(api, container.channels);
      api.get("/agents", async (req) =>
        container.registry
          .active()
          .filter((m) => req.principal.capabilities.includes(m.capability))
          .map((m) => ({
            id: m.id,
            version: m.version,
            title: m.title,
            description: m.description,
            inputSchema: z.toJSONSchema(m.input),
            example: m.example,
          })),
      );
      api.post("/tasks", async (req, reply) => {
        const data = Create.parse(req.body);
        const key = Key.parse(req.headers["idempotency-key"]);
        const task = await container.telemetry.run(
          "http.task.create",
          { "request.id": req.id },
          () =>
            container.service.create(
              req.principal,
              data.moduleId,
              data.input,
              key,
              data.conversationId,
            ),
        );
        return reply.code(202).send({
          id: task.id,
          status: task.status,
          conversationId: task.conversation_id,
        });
      });
      api.get("/tasks", async (req) =>
        container.service.list(
          req.principal,
          z
            .object({
              offset: z.coerce.number().int().min(0).max(1000000).default(0),
            })
            .parse(req.query).offset,
        ),
      );
      api.get("/tasks/:id", async (req) =>
        container.service.detail(req.principal, Id.parse(req.params).id),
      );
      api.post("/tasks/:id/cancel", async (req) => {
        endpoints.cancel.body.parse(req.body ?? {});
        await container.service.cancel(req.principal, Id.parse(req.params).id);
        return { ok: true };
      });
      api.post("/tasks/:id/retry", async (req) => {
        endpoints.retry.body.parse(req.body ?? {});
        await container.service.retry(req.principal, Id.parse(req.params).id);
        return { ok: true };
      });
      api.post("/tasks/:id/reconciliation", async (req) => {
        await container.service.reconcile(
          req.principal,
          Id.parse(req.params).id,
          Key.parse(req.headers["idempotency-key"]),
          Reconciliation.parse(req.body),
        );
        return { ok: true };
      });
      api.post("/tasks/:id/inputs", async (req) => {
        const body = InputResponse.parse(req.body);
        await container.service.respond(
          req.principal,
          body.waitId,
          body.response,
          Key.parse(req.headers["idempotency-key"]),
          Id.parse(req.params).id,
        );
        return { ok: true };
      });
      api.post("/waits/:id/decisions", async (req) => {
        await container.service.respond(
          req.principal,
          Id.parse(req.params).id,
          Response.parse(req.body).response,
          Key.parse(req.headers["idempotency-key"]),
        );
        return { ok: true };
      });
      api.post("/tasks/:id/signals", async (req) => {
        const body = Signal.parse(req.body);
        await container.service.signal(
          req.principal,
          Id.parse(req.params).id,
          body.waitKey,
          body.response,
          Key.parse(req.headers["idempotency-key"]),
        );
        return { ok: true };
      });
      api.get("/tasks/:id/events", async (req, reply) => {
        const id = Id.parse(req.params).id;
        const query = z
          .object({
            after: z
              .string()
              .regex(/^\d{1,18}$/)
              .default("0"),
            format: z.enum(["json", "sse"]).default("sse"),
          })
          .parse(req.query);
        const events = await container.service.events(
          req.principal,
          id,
          query.after,
        );
        if (query.format === "json") return events;
        // 有限批次 SSE：重连携带游标；不为闲置浏览器长期占用数据库连接。
        return reply
          .header("cache-control", "no-store")
          .type("text/event-stream")
          .send(
            `retry: 1000\n\n${events.map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")}`,
          );
      });
      api.get<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
        const file = await container.downloads.get(
          req.principal,
          Id.parse(req.params).id,
        );
        return reply
          .header("content-type", file.mediaType)
          .header("x-content-type-options", "nosniff")
          .header(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          )
          .send(file.data);
      });
      api.get("/artifacts/:id", async (req) =>
        container.service.artifact(req.principal, Id.parse(req.params).id),
      );
      api.get("/conversations", async (req) =>
        container.service.conversations(req.principal),
      );
      api.get("/conversations/:id/messages", async (req) =>
        container.service.conversation(req.principal, Id.parse(req.params).id),
      );
      api.get("/schedules", async (req) =>
        container.schedules.list(req.principal),
      );
      api.post("/schedules", async (req) => {
        const data = Create.omit({ conversationId: true })
          .extend({ intervalSeconds: z.number().int().min(60).max(31536000) })
          .parse(req.body);
        return container.schedules.create(
          req.principal,
          data.moduleId,
          data.input,
          data.intervalSeconds,
        );
      });
      api.delete("/schedules/:id", async (req) => {
        await container.schedules.remove(
          req.principal,
          Id.parse(req.params).id,
        );
        return { ok: true };
      });
      api.get("/operations", async (req) => {
        requireCapability(req.principal, "operations:read");
        return container.operations.snapshot(
          req.principal.workspace_id,
          req.principal.capabilities.includes("operations:cluster"),
        );
      });
      api.get("/metrics", async (req, reply) => {
        requireCapability(req.principal, "operations:read");
        return reply
          .type("text/plain")
          .send(
            await container.operations.metrics(
              req.principal.workspace_id,
              req.principal.capabilities.includes("operations:cluster"),
            ),
          );
      });
    },
    { prefix: "/v1" },
  );
  const staticRoot = resolve(options.staticRoot ?? "dist/web");
  if (existsSync(resolve(staticRoot, "index.html")))
    await app.register(staticFiles, { root: staticRoot, prefix: "/" });
  return app;
}
