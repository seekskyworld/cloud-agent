/** 管理按账户和工作区授权；回调通过供应商端口验签，不在 API 硬编码供应商协议。 */
import type { FastifyInstance } from "fastify";
import { MailCommand as Command } from "../../packages/api/management.js";
import { Problem } from "../../packages/contracts/index.js";
import type { MailChannel } from "../../packages/mail/channel.js";
function account(mails: MailChannel[], id: string) {
  const found = mails.find((mail) => mail.store.id === id);
  if (!found) throw new Problem(404, "MAIL_ACCOUNT_NOT_FOUND");
  return found;
}
function workspaceAccount(mails: MailChannel[], id: string, workspace: string) {
  const found = mails.find(
    (mail) =>
      mail.store.id === id && mail.store.settings.workspace === workspace,
  );
  // 管理端点不暴露其他工作区的账户是否存在。
  if (!found) throw new Problem(404, "MAIL_ACCOUNT_NOT_FOUND");
  return found;
}
export async function registerMailWebhook(
  app: FastifyInstance,
  mails: MailChannel[],
) {
  if (!mails.length) return;
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1_100_000 },
      (_req, body, done) => done(null, body),
    );
    scope.post<{ Params: { id: string } }>(
      "/hooks/mail/:id",
      { bodyLimit: 1_100_000 },
      async (req, reply) => {
        const mail = account(mails, req.params.id);
        const event = await mail.verifyWebhook(req.body as Buffer, req.headers);
        return reply.code(202).send(await mail.store.receive(event));
      },
    );
    // 原单邮箱部署继续使用旧路径；多账户必须显式指定 ID，避免回调落错邮箱。
    if (mails.length === 1)
      scope.post(
        "/hooks/agentmail",
        { bodyLimit: 1_100_000 },
        async (req, reply) => {
          const mail = mails[0]!;
          return reply
            .code(202)
            .send(
              await mail.store.receive(
                await mail.verifyWebhook(req.body as Buffer, req.headers),
              ),
            );
        },
      );
  });
}
export function registerMailAdministration(
  api: FastifyInstance,
  mails: MailChannel[],
) {
  api.get("/admin/mail", async (req) => {
    if (req.principal.role === "member") throw new Problem(403, "FORBIDDEN");
    if (!mails.length) return { enabled: false, accounts: [] };
    const visible = mails.filter(
      (mail) => mail.store.settings.workspace === req.principal.workspace_id,
    );
    if (!visible.length) throw new Problem(403, "FORBIDDEN");
    const accounts = await Promise.all(
      visible.map(async (mail) => ({
        id: mail.store.id,
        ...(await mail.store.status()),
      })),
    );
    return {
      enabled: true,
      accounts,
      ...(mails.length === 1 ? accounts[0] : {}),
    };
  });
  api.post<{ Params: { id: string } }>(
    "/admin/mail/:id/commands",
    async (req) => {
      const mail = workspaceAccount(
        mails,
        req.params.id,
        req.principal.workspace_id,
      );
      await mail.store.manage(req.principal, Command.parse(req.body));
      return { ok: true };
    },
  );
  api.post("/admin/mail/commands", async (req) => {
    if (!mails.length) throw new Problem(409, "MAIL_DISABLED");
    if (mails.length !== 1) throw new Problem(409, "MAIL_ACCOUNT_REQUIRED");
    await mails[0]!.store.manage(req.principal, Command.parse(req.body));
    return { ok: true };
  });
}
