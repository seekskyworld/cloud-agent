// 只恢复到本次创建的临时数据库；不覆盖现有生产库或用户数据库。
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
const path = process.argv[2];
if (!path)
  throw new Error("Usage: node scripts/restore-check.mjs backups/name.sql");
const name = `cloud_agent_restore_test_${randomBytes(8).toString("hex")}`;
async function command(args, input) {
  const child = spawn("docker", ["compose", "exec", "-T", "db", ...args], {
    stdio: [input ? "pipe" : "ignore", "inherit", "inherit"],
  });
  if (input) {
    input.on("error", () => child.kill());
    input.pipe(child.stdin);
  }
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`restore command exited ${code}`)),
    );
  });
}
await command(["createdb", "-U", "cloud_agent_owner", name]);
try {
  await command(
    ["psql", "-U", "cloud_agent_owner", "-d", name, "-v", "ON_ERROR_STOP=1"],
    createReadStream(path),
  );
  await command([
    "psql",
    "-U",
    "cloud_agent_owner",
    "-d",
    name,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DO $$ BEGIN IF EXISTS(SELECT 1 FROM artifacts a LEFT JOIN tasks t ON a.task_id=t.id WHERE t.id IS NULL) THEN RAISE EXCEPTION 'orphan artifact'; END IF; END $$; SELECT status,count(*) FROM tasks GROUP BY status;",
  ]);
  process.stdout.write(
    "Isolated restore and task/artifact integrity check passed\n",
  );
} finally {
  await command(["dropdb", "-U", "cloud_agent_owner", name]);
}
