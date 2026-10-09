/** 仅用迁移/运维数据库身份初始化受保护超级管理员，不接受 HTTP 或模型调用。 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { Database } from "../packages/persistence/database.js";
import { bootstrapSuperadmin } from "../packages/identity/bootstrap.js";
const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    principal: { type: "string" },
    reason: { type: "string" },
    capabilities: { type: "string" },
  },
});
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || !values.workspace || !values.principal || !values.reason)
  throw new Error("Database URL and --workspace --principal --reason required");
const db = new Database(url);
try {
  await bootstrapSuperadmin(
    db,
    values.workspace,
    values.principal,
    values.reason,
    values.capabilities === undefined
      ? undefined
      : values.capabilities.split(",").filter(Boolean),
  );
  process.stdout.write("Protected superadmin configured\n");
} finally {
  await db.close();
}
