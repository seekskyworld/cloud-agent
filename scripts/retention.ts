/** 默认只预览；只使用显式运维连接清理正文，保留防重放记录。 */
import "dotenv/config";
import { Database } from "../packages/persistence/database.js";
import { DataRetention } from "../packages/persistence/retention.js";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
const db = new Database(url);
try {
  process.stdout.write(
    JSON.stringify(
      await new DataRetention(db).run(
        Number(process.env.DATA_RETENTION_DAYS ?? 90),
        process.argv.includes("--apply"),
        "retention-cli",
      ),
    ) + "\n",
  );
} finally {
  await db.close();
}
