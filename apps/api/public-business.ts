/** 只有显式声明的公开 GET；不继承本地共享主体，也不注册匿名写入口。 */
import type { FastifyInstance } from "fastify";
import { JsonSchema } from "../../packages/contracts/index.js";
import { bounded } from "../../packages/contracts/lifecycle.js";
import type { BusinessApplications } from "../../packages/business/application.js";
export function registerPublicBusiness(
  app: FastifyInstance,
  applications: BusinessApplications,
) {
  for (const { id, instance } of applications.entries) {
    for (const route of instance.publicReads ?? []) {
      app.get(`/public/business/${id}/${route.id}`, async (req, reply) => {
        reply
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff");
        const input = route.input.parse(req.query);
        const result = await bounded(15000, (signal) =>
          route.handle(input, { signal }),
        );
        return JsonSchema.parse(route.output.parse(result));
      });
    }
  }
}
