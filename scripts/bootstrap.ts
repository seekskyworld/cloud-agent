import { businessPackages } from "../modules/packages.js";
import { businessPermissions } from "../apps/business.js";
import { loadBusinessDeployments } from "../packages/business/index.js";
/** 初始化固定身份；令牌模式可更新摘要，但保留已有权限和启用状态。 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createModules, registeredCapabilities } from "../apps/modules.js";
import { Database, tokenHash } from "../packages/persistence/database.js";
const mode = z.enum(["none", "token"]).parse(process.env.AUTH_MODE ?? "none");
// 无认证模式仍保存不可用的随机摘要以兼容身份表，不生成用户需要设置的访问令牌。
const token =
  mode === "token"
    ? process.env.BOOTSTRAP_TOKEN
    : randomBytes(32).toString("hex");
if (!token || token.length < 24)
  throw new Error("BOOTSTRAP_TOKEN must contain at least 24 characters");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new Database(process.env.DATABASE_URL);
try {
  await db.transaction(async (client) => {
    const workspace =
      process.env.LOCAL_WORKSPACE ??
      process.env.BOOTSTRAP_WORKSPACE ??
      "default";
    const id =
      process.env.LOCAL_PRINCIPAL ?? process.env.BOOTSTRAP_PRINCIPAL ?? "owner";
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `cloud-agent-access:${workspace}`,
    ]);
    const created = await client.query(
      `INSERT INTO principals(id,workspace_id,token_hash,capabilities,role) VALUES($1,$2,$3,$4,'superadmin')
       ON CONFLICT(workspace_id,id) DO NOTHING RETURNING id,workspace_id,capabilities,role,enabled,access_version`,
      [
        id,
        workspace,
        tokenHash(token),
        [
          ...new Set([
            ...registeredCapabilities(
              createModules({
                examples: process.env.EXAMPLES_ENABLED === "true",
              }),
            ),
            ...businessPermissions(
              businessPackages,
              loadBusinessDeployments(process.env.BUSINESS_PACKAGES),
            ),
          ]),
        ],
      ],
    );
    if (created.rowCount) {
      await client.query(
        "INSERT INTO administration_audit(workspace_id,actor_id,target_id,action,reason,after_access) VALUES($1,'system:bootstrap',$2,'superadmin.bootstrapped','首次初始化工作区',$3)",
        [workspace, id, JSON.stringify(created.rows[0])],
      );
    } else if (mode === "token") {
      await client.query(
        "UPDATE principals SET token_hash=$3 WHERE workspace_id=$1 AND id=$2",
        [workspace, id, tokenHash(token)],
      );
    }
  });
  process.stdout.write(`Bootstrap complete; auth mode: ${mode}\n`);
} finally {
  await db.close();
}
