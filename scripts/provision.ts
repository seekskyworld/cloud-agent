/** 给运行账号授予 DML 权限；迁移账号与运行账号分离，不向 API 暴露 owner 密码。 */
import "dotenv/config";
import { Database } from "../packages/persistence/database.js";
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const password = process.env.RUNTIME_PASSWORD;
if (!url || !password || !/^[a-zA-Z0-9_-]{24,128}$/.test(password))
  throw new Error("Database URL and 24+ character RUNTIME_PASSWORD required");
const db = new Database(url);
try {
  await db.transaction(async (client) => {
    const exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname='cloud_agent_app'",
    );
    // 密码已严格限制字符，角色固定；PostgreSQL DDL 不支持参数化密码位置。
    if (!exists.rowCount)
      await client.query(
        `CREATE ROLE cloud_agent_app LOGIN PASSWORD '${password}'`,
      );
    else
      await client.query(`ALTER ROLE cloud_agent_app PASSWORD '${password}'`);
    await client.query("GRANT USAGE ON SCHEMA public TO cloud_agent_app");
    await client.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cloud_agent_app",
    );
    await client.query(
      "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cloud_agent_app",
    );
    await client.query(
      "REVOKE INSERT,UPDATE,DELETE ON identity_registration_policies,identity_bindings FROM cloud_agent_app",
    );
    await client.query(
      "GRANT EXECUTE ON FUNCTION register_verified_identity(text,text,text) TO cloud_agent_app",
    );
    await client.query(
      "REVOKE ALL ON principals,schema_migrations,business_migrations,administration_audit,administration_commands FROM cloud_agent_app",
    );
    await client.query(
      "GRANT SELECT ON principals,schema_migrations,business_migrations TO cloud_agent_app",
    );
    await client.query(
      "GRANT SELECT ON administration_audit TO cloud_agent_app",
    );
    await client.query(
      "REVOKE UPDATE,DELETE ON mail_service_receipts,governance_commands,token_audit,retention_audit,delegation_audit,deployment_revisions,deployment_audit,business_requests,context_snapshots,task_reconciliations,channel_audit,mail_audit FROM cloud_agent_app",
    );
    await client.query(
      "REVOKE INSERT,UPDATE,DELETE ON task_archives FROM cloud_agent_app",
    );
    await client.query(
      "REVOKE INSERT,UPDATE,DELETE ON platform_maintenance,retention_audit,deployment_activation FROM cloud_agent_app",
    );
    await client.query(
      "GRANT EXECUTE ON FUNCTION runtime_maintenance_enabled(),runtime_deployment_revision(),runtime_lock_principals(text,text[]) TO cloud_agent_app",
    );
    await client.query(
      "GRANT EXECUTE ON FUNCTION manage_principal_access(text,text,text,text,text[],boolean,integer,text,text,text) TO cloud_agent_app",
    );
  });
  process.stdout.write("Runtime role provisioned\n");
} finally {
  await db.close();
}
