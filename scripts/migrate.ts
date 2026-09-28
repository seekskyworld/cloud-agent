/** 迁移使用独立连接，校验已应用迁移的内容指纹。 */
import "dotenv/config";
import { Database } from "../packages/persistence/database.js";
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = new Database(url);
try {
  await db.migrate();
  process.stdout.write("Migrations applied\n");
} finally {
  await db.close();
}
