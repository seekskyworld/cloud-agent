/** 所有已注册存储逐一预览/清理，单次每个存储最多删除 100 个过期对象。 */
import "dotenv/config";
import { loadConfig } from "../apps/config.js";
import { createApplication } from "../apps/application.js";
const config = loadConfig();
config.DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
const container = await createApplication(config);
try {
  if (!container.stores.size) throw new Error("ARTIFACT_STORE_DISABLED");
  for (const [id, files] of container.stores) {
    if (process.argv.includes("--apply"))
      process.stdout.write(`${id}: deleted ${await files.prune()}\n`);
    else {
      const rows = await container.db.pool.query(
        "SELECT count(*)::text FROM file_artifacts WHERE expires_at<=now() AND store_id=$1",
        [id],
      );
      process.stdout.write(
        `${id}: expired ${rows.rows[0].count}; use --apply to delete at most 100\n`,
      );
    }
  }
} finally {
  await container.close();
}
