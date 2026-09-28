// 每次创建独立数据库；只删除本进程创建的测试库，避免清理用户业务数据。
import pg from "pg";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const source =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://cloud_agent_test:local-test-only@127.0.0.1:55439/cloud_agent_test";
const url = new URL(source);
if (!url.pathname.includes("_test"))
  throw new Error("Test admin database must contain _test");
const dbName = `cloud_agent_test_${randomBytes(8).toString("hex")}`;
const admin = new pg.Pool({ connectionString: source });
try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  url.pathname = `/${dbName}`;
  const args = process.argv.includes("--coverage")
    ? [
        "exec",
        "tsx",
        "--conditions=development",
        "--test",
        "--experimental-test-coverage",
        "--test-coverage-lines=80",
        "--test-coverage-branches=80",
        "--test-coverage-functions=80",
        "--test-coverage-include=packages/**",
        "--test-concurrency=1",
        ...(await readdir("tests"))
          .filter((n) => n.endsWith(".test.ts"))
          .map((n) => `tests/${n}`),
      ]
    : ["test"];
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: url.toString(),
      LOG_LEVEL: "silent",
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
}
