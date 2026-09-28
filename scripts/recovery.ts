/** 联合恢复只导入空库；默认校验不修改部署。运行时账号无维护开关写权限。 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { createContainer } from "../apps/container.js";
import { loadConfig } from "../apps/config.js";
import {
  exportBundle,
  collectSecretReferences,
  verifyBundle,
  restoreObjects,
} from "../packages/recovery/index.js";
const [operation, directory] = process.argv.slice(2);
if (
  !operation ||
  !directory ||
  !["verify", "backup", "restore"].includes(operation)
)
  throw new Error("Usage: recovery <verify|backup|restore> <directory>");
if (operation === "verify") {
  await verifyBundle(directory);
  process.stdout.write("Bundle verified\n");
} else {
  const config = loadConfig(),
    url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
  config.DATABASE_URL = url;
  const c = await createContainer(config),
    connection = new URL(url);
  const args = ["compose", "exec", "-T", "db"];
  const common = [
    "-U",
    decodeURIComponent(connection.username),
    "-d",
    connection.pathname.slice(1),
  ];
  try {
    if (operation === "backup") {
      await c.db.pool.query(
        "UPDATE platform_maintenance SET enabled=true,reason='joint backup',updated_at=now()",
      );
      // 调用者应先停止 API/Worker；有在途执行时拒绝备份，不擅自取消任务。
      await exportBundle(
        c.db,
        c.stores,
        directory,
        (path) =>
          transfer(
            [...args, "pg_dump", ...common, "--no-owner", "--no-acl"],
            path,
            false,
          ),
        collectSecretReferences(c.config),
      );
      await c.db.pool.query(
        "UPDATE platform_maintenance SET enabled=false,reason='',updated_at=now()",
      );
    } else {
      await verifyBundle(directory);
      if (
        (
          await c.db.pool.query(
            "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') LIMIT 1",
          )
        ).rowCount
      )
        throw new Error("RESTORE_REQUIRES_EMPTY_DATABASE");
      await transfer(
        [...args, "psql", ...common, "-v", "ON_ERROR_STOP=1"],
        join(directory, "database.sql"),
        true,
      );
      await restoreObjects(c.db, c.stores, directory);
      await c.db.pool.query(
        "UPDATE platform_maintenance SET enabled=false,reason='',updated_at=now()",
      );
    }
    process.stdout.write(`Recovery ${operation} verified\n`);
  } finally {
    await c.close();
  }
}
async function transfer(args: string[], path: string, input: boolean) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("DATABASE_TRANSFER_FAILED")),
    );
  });
  if (input) {
    child.stdout.resume();
    await Promise.all([pipeline(createReadStream(path), child.stdin), exited]);
  } else {
    child.stdin.end();
    await Promise.all([
      pipeline(
        child.stdout,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      ),
      exited,
    ]);
  }
}
