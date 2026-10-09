import type { PoolClient } from "pg";
import type { DeploymentManifest } from "../contracts/deployment.js";
/** 保守报告：终态任务仍有未知副作用时，也不能移除它的执行代码。 */
export async function upgradeImpact(
  client: Pick<PoolClient, "query">,
  modules: DeploymentManifest["modules"],
) {
  const rows = await client.query<{
    module_id: string;
    module_version: string;
    config_hash: string;
    tasks: number;
  }>(
    `
    SELECT t.module_id,t.module_version,t.config_hash,count(*)::int AS tasks FROM tasks t
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS m(id text,version text,hash text)
      WHERE m.id=t.module_id AND m.version=t.module_version AND m.hash=t.config_hash)
    AND (t.status NOT IN ('succeeded','failed','cancelled')
      OR EXISTS(SELECT 1 FROM tool_invocations i WHERE i.task_id=t.id AND i.status IN ('unknown','dispatching'))
      OR EXISTS(SELECT 1 FROM model_requests m WHERE m.task_id=t.id AND m.state IN ('running','cancelling','unknown') AND m.quarantine_until>now())
      OR EXISTS(SELECT 1 FROM mail_outbox o WHERE (o.task_id=t.id OR o.source_task=t.id) AND o.state NOT IN ('sent','cancelled'))
      OR EXISTS(SELECT 1 FROM channel_outbox o WHERE o.task_id=t.id AND o.state NOT IN ('sent','cancelled')))
    GROUP BY t.module_id,t.module_version,t.config_hash ORDER BY t.module_id,t.module_version,t.config_hash`,
    [JSON.stringify(modules)],
  );
  return { safe: rows.rows.length === 0, blockers: rows.rows };
}
