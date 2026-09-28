/** 显式运行才注册外部回调；凭据原子写回忽略文件，标准输出不含密钥。 */
import { readFile, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import { registerAccountWebhook } from "./mail-registration.js";
import { registerWebhook } from "../adapters/agentmail/registration.js";
async function main() {
  const [filename, callback, accountId] = process.argv.slice(2);
  if (!filename || !callback)
    throw new Error(
      "MAIL_USAGE: pnpm mail:webhook .env https://your-host/hooks/agentmail",
    );
  const file = resolve(filename);
  execFileSync("git", ["check-ignore", "--quiet", file]);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("MAIL_ENV_FILE_REQUIRED");
  let contents = await readFile(file, "utf8");
  const env = parse(contents);
  const save = async (values: Record<string, string>) => {
    if ((await readFile(file, "utf8")) !== contents)
      throw new Error("MAIL_ENV_CHANGED");
    let updated = contents;
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Z_]+$/.test(key) || /[\r\n]/.test(value))
        throw new Error("MAIL_ENV_VALUE_INVALID");
      const line = `${key}='${value.replace(/'/g, "\\u0027")}'`,
        pattern = new RegExp(`^${key}=.*$`, "gm");
      updated = pattern.test(updated)
        ? updated.replace(pattern, () => line)
        : `${updated.trimEnd()}\n${line}\n`;
    }
    const temporary = join(dirname(file), `.env.mail-${randomUUID()}.local`);
    execFileSync("git", ["check-ignore", "--quiet", temporary]);
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
    contents = updated;
  };
  if (env.MAIL_MODE === "accounts") {
    if (!accountId) throw new Error("MAIL_ACCOUNT_REQUIRED");
    await registerAccountWebhook(env, accountId, callback, save);
  } else {
    if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX)
      throw new Error("MAIL_KEY_AND_INBOX_REQUIRED");
    await registerWebhook({
      baseUrl: env.AGENTMAIL_BASE_URL || "https://api.agentmail.to/v0",
      apiKey: env.AGENTMAIL_API_KEY,
      url: callback,
      saved: env,
      save,
    });
  }
  process.stdout.write(
    "Webhook ready. Credentials saved privately; recreate API/Worker before enabling webhook mode.\n",
  );
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^MAIL_[A-Z_: /.]+$/.test(error.message)
      ? error.message
      : "MAIL_REGISTRATION_FAILED";
  process.stderr.write(
    `${code}; inspect provider inventory before retrying.\n`,
  );
  process.exitCode = 1;
});
