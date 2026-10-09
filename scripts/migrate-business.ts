/** 部署阶段显式执行业务迁移，运行时不会自动获取 DDL 权限。 */
import "dotenv/config";
import { Database } from "../packages/persistence/database.js";
import { migrateBusiness } from "../packages/persistence/business.js";
import { loadBusinessDeployments } from "../packages/business/index.js";
import { businessPackages } from "../modules/packages.js";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
const db = new Database(url);
try {
  for (const deployment of loadBusinessDeployments(
    process.env.BUSINESS_PACKAGES,
  ).filter((d) => d.enabled)) {
    const manifest = businessPackages.find((p) => p.id === deployment.id);
    if (!manifest) throw new Error("BUSINESS_NOT_REGISTERED");
    await migrateBusiness(db, manifest);
  }
  process.stdout.write("Business migrations applied\n");
} finally {
  await db.close();
}
