/** 注册账户回调并回写同一凭据引用；令牌先持久化，远端结果未知时由原注册器禁止盲目重试。 */
import { readFile, lstat, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { AgentMailAccount } from "../adapters/agentmail/extension.js";
import { loadMailAccounts } from "../apps/mail-accounts.js";
import { registerWebhook } from "../adapters/agentmail/registration.js";
const Secret = z.object({
  kind: z.literal("api-key"),
  apiKey: z.string().min(1),
  webhookToken: z.string().optional(),
  webhookSecret: z.string().optional(),
  webhookId: z.string().optional(),
  webhookUrl: z.string().optional(),
});
export async function registerAccountWebhook(
  env: Record<string, string>,
  accountId: string,
  callback: string,
  saveEnv: (values: Record<string, string>) => Promise<void>,
  transport: typeof fetch = fetch,
) {
  const account = loadMailAccounts(env).find((value) => value.id === accountId);
  if (!account || account.provider !== "agentmail")
    throw new Error("MAIL_ACCOUNT_REQUIRED");
  if (new URL(callback).pathname !== `/hooks/mail/${accountId}`)
    throw new Error("MAIL_CALLBACK_URL_INVALID");
  const file = env.MAIL_CREDENTIALS_FILE
    ? resolve(env.MAIL_CREDENTIALS_FILE)
    : undefined;
  let raw = env.MAIL_CREDENTIALS ?? "{}";
  if (file) {
    execFileSync("git", ["check-ignore", "--quiet", file]);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 100_000
    )
      throw new Error("MAIL_CREDENTIAL_FILE_UNSAFE");
    raw = await readFile(file, "utf8");
  }
  const map = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  const secret = Secret.parse(map[account.credential]);
  await registerWebhook(
    {
      baseUrl: AgentMailAccount.parse(account.options).baseUrl,
      apiKey: secret.apiKey,
      url: callback,
      saved: {
        AGENTMAIL_WEBHOOK_TOKEN: secret.webhookToken ?? "",
        AGENTMAIL_WEBHOOK_SECRET: secret.webhookSecret ?? "",
        AGENTMAIL_WEBHOOK_ID: secret.webhookId ?? "",
      },
      save: async (values) => {
        const fields: Record<string, string> = {
          AGENTMAIL_WEBHOOK_TOKEN: "webhookToken",
          AGENTMAIL_WEBHOOK_SECRET: "webhookSecret",
          AGENTMAIL_WEBHOOK_ID: "webhookId",
          AGENTMAIL_WEBHOOK_URL: "webhookUrl",
        };
        Object.assign(
          secret,
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [fields[key]!, value]),
          ),
        );
        map[account.credential] = secret;
        const updated = JSON.stringify(map);
        if (!file) {
          await saveEnv({ MAIL_CREDENTIALS: updated });
          return;
        }
        if ((await readFile(file, "utf8")) !== raw)
          throw new Error("MAIL_CREDENTIAL_FILE_CHANGED");
        const temporary = join(
          dirname(file),
          `.env.mail-${randomUUID()}.local`,
        );
        execFileSync("git", ["check-ignore", "--quiet", temporary]);
        await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
        try {
          await rename(temporary, file);
        } catch (error) {
          await unlink(temporary);
          throw error;
        }
        raw = updated;
      },
    },
    transport,
  );
}
