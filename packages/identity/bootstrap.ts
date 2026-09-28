/** 超级管理员仅由可信运维配置；省略 capabilities 保留原能力，显式传入则审计替换，禁用身份不复活。 */
import { z } from "zod";
import type { Database } from "../persistence/database.js";
import { Problem } from "../contracts/index.js";
export async function bootstrapSuperadmin(
  db: Database,
  workspace: string,
  id: string,
  reason: string,
  capabilities?: string[],
) {
  if (!workspace.trim() || !id.trim() || !reason.trim())
    throw new Error("Workspace, principal and reason required");
  const desired =
    capabilities === undefined
      ? undefined
      : [
          ...new Set(
            z
              .array(z.string().trim().min(1).max(120))
              .max(100)
              .parse(capabilities),
          ),
        ].sort();
  return db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `cloud-agent-access:${workspace}`,
    ]);
    const row = (
      await client.query(
        "SELECT id,workspace_id,role,capabilities,enabled,access_version FROM principals WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new Problem(404, "PRINCIPAL_NOT_FOUND");
    if (!row.enabled) throw new Problem(403, "IDENTITY_REVOKED");
    if (
      row.role === "superadmin" &&
      (desired === undefined ||
        JSON.stringify([...row.capabilities].sort()) ===
          JSON.stringify(desired))
    )
      return row;
    const updated = (
      await client.query(
        "UPDATE principals SET role='superadmin',capabilities=COALESCE($3::text[],capabilities),access_version=access_version+1 WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id,role,capabilities,enabled,access_version",
        [workspace, id, desired ?? null],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO administration_audit(workspace_id,actor_id,target_id,action,reason,before_access,after_access) VALUES($1,'system:bootstrap',$2,$6,$3,$4,$5)",
      [
        workspace,
        id,
        reason,
        JSON.stringify(row),
        JSON.stringify(updated),
        row.role === "superadmin"
          ? "superadmin.configured"
          : "superadmin.bootstrapped",
      ],
    );
    return updated;
  });
}
