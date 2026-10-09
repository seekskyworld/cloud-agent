/** 只由部署账号显式控制维护门禁；关闭前须确认恢复/清理操作已结束。 */
import "dotenv/config";
import { Database } from "../packages/persistence/database.js";
const [mode, reason] = process.argv.slice(2),
  url = process.env.MIGRATION_DATABASE_URL;
if (!url || !["on", "off"].includes(mode ?? "") || !reason?.trim())
  throw new Error(
    "Usage: MIGRATION_DATABASE_URL=... maintenance <on|off> <reason>",
  );
const db = new Database(url);
try {
  await db.pool.query(
    "UPDATE platform_maintenance SET enabled=$1,reason=$2,updated_at=now()",
    [mode === "on", reason],
  );
  process.stdout.write(`Maintenance ${mode}\n`);
} finally {
  await db.close();
}
