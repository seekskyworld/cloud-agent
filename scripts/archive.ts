/** 默认只预览；必须显式 --apply，使用运维账号，不在 Worker 自动清理。 */
import "dotenv/config";
import { z } from "zod";
import { Database } from "../packages/persistence/database.js";
import { ArchiveStore } from "../packages/persistence/archive.js";
const policy = z
  .object({
    RETENTION_DAYS: z.coerce.number().int().min(1).max(36500),
    ARCHIVE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  })
  .parse(process.env);
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Database URL required");
if (process.argv.slice(2).some((arg) => arg !== "--apply"))
  throw new Error("Usage: pnpm archive [--apply]");
const db = new Database(url);
try {
  const result = await new ArchiveStore(db).run({
    retentionDays: policy.RETENTION_DAYS,
    batchSize: policy.ARCHIVE_BATCH_SIZE,
    apply: process.argv.includes("--apply"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await db.close();
}
