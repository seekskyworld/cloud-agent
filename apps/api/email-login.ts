/** 可选邮箱登录 HTTP 入口；不建立第二套身份、会话或投递状态机。 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Problem } from "../../packages/contracts/index.js";
import type { EmailLogin } from "../../packages/identity/email-login.js";
import type { CookieIdentityProvider } from "../../packages/identity/cookie.js";
export async function registerEmailLogin(
  app: FastifyInstance,
  login: EmailLogin,
  cookie: CookieIdentityProvider,
) {
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        if (req.headers.origin !== cookie.origin)
          throw new Problem(403, "AUTH_ORIGIN_REJECTED");
      });
      scope.post(
        "/request",
        { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
        async (req) =>
          login.request(
            z.object({ email: z.email() }).strict().parse(req.body).email,
            req.ip,
          ),
      );
      scope.post(
        "/verify",
        { config: { rateLimit: { max: 30, timeWindow: 60000 } } },
        async (req, reply) => {
          const b = z
            .object({ id: z.uuid(), code: z.string().regex(/^\d{6}$/) })
            .strict()
            .parse(req.body);
          const token = await login.verify(b.id, b.code);
          reply.header("Set-Cookie", cookie.cookie(token, 2592000));
          return { ok: true };
        },
      );
      scope.post("/logout", async (req, reply) => {
        const values = (req.headers.cookie ?? "")
          .split(";")
          .map((v) => v.trim())
          .filter((v) => v.startsWith(cookie.name + "="));
        if (values.length === 1)
          await login.logout(values[0]!.slice(cookie.name.length + 1));
        reply.header("Set-Cookie", cookie.clearCookie());
        return { ok: true };
      });
    },
    { prefix: "/auth/email" },
  );
}
