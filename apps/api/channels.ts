/** 通用渠道 API：入站独立验签，管理查询只在当前工作区可见。 */
import type { FastifyInstance } from "fastify";
import { ChannelCommand } from "../../packages/api/management.js";
import { Problem } from "../../packages/contracts/index.js";
import type { MessageChannel } from "../../packages/channels/channel.js";
export async function registerChannelHooks(
  app: FastifyInstance,
  channels: MessageChannel[],
) {
  if (!channels.length) return;
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 128000 },
      (_request, body, done) => done(null, body),
    );
    scope.post<{ Params: { id: string } }>(
      "/hooks/channels/:id",
      async (req, reply) => {
        const channel = channels.find((c) => c.settings.id === req.params.id);
        if (!channel) throw new Problem(404, "CHANNEL_NOT_FOUND");
        return reply
          .code(202)
          .send(await channel.receive(req.body as Buffer, req.headers));
      },
    );
  });
}
export function registerChannelAdmin(
  api: FastifyInstance,
  channels: MessageChannel[],
) {
  api.get("/admin/channels", async (req) => {
    if (req.principal.role === "member") throw new Problem(403, "FORBIDDEN");
    return Promise.all(
      channels
        .filter((c) => c.settings.workspace === req.principal.workspace_id)
        .map((c) => c.status()),
    );
  });
  api.post<{ Params: { id: string } }>(
    "/admin/channels/:id/commands",
    async (req) => {
      const channel = channels.find(
        (c) =>
          c.settings.id === req.params.id &&
          c.settings.workspace === req.principal.workspace_id,
      );
      if (!channel) throw new Problem(404, "CHANNEL_NOT_FOUND");
      const input = ChannelCommand.parse(req.body);
      await channel.resolve(req.principal, input);
      return { ok: true };
    },
  );
}
