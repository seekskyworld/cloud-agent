// 从 Compose 数据库导出自包含 SQL；文件权限为 0600，不输出数据或认证信息。
import { spawn } from "node:child_process";
import { mkdir, rm, open } from "node:fs/promises";
const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/backup.mjs backups/name.sql");
await mkdir("backups", { recursive: true });
const file = await open(path, "wx", 0o600);
const output = file.createWriteStream();
const child = spawn(
  "docker",
  [
    "compose",
    "exec",
    "-T",
    "db",
    "pg_dump",
    "-U",
    "cloud_agent_owner",
    "-d",
    "cloud_agent",
    "--no-owner",
    "--no-acl",
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
child.stdout.pipe(output);
try {
  await Promise.all([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`)),
      );
    }),
    new Promise((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    }),
  ]);
  process.stdout.write(`Backup saved to ${path}\n`);
} catch (error) {
  child.kill();
  output.destroy();
  await rm(path, { force: true });
  throw error;
}
