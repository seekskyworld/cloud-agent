/** 业务迁移与定时作业使用独立账本；迁移不能在请求/Worker 进程执行。 */
import { JobChange } from "../contracts/governance.js";
import { governanceCommand } from "./governance.js";
import type { BusinessPackage, BusinessDeployment } from "../business/index.js";
import type {
  BusinessApplications,
  BusinessJob,
} from "../business/application.js";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../contracts/index.js";
import { Database } from "./database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { TaskStore } from "./tasks.js";
export async function migrateBusiness(db: Database, manifest: BusinessPackage) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id))
    throw new Error("BUSINESS_ID_INVALID");
  const schema = `business_${manifest.id.replaceAll("-", "_")}`;
  // PostgreSQL 标识符有 63 字节上限；拒绝截断产生的命名冲突。
  if (schema.length > 63) throw new Error("BUSINESS_SCHEMA_TOO_LONG");
  await db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    for (const migration of manifest.migrations ?? []) {
      if (!/^[0-9]{3,}_[a-z0-9_]+$/.test(migration.id))
        throw new Error("BUSINESS_MIGRATION_ID_INVALID");
      const checksum = fingerprint(migration.sql);
      const old = (
        await client.query<{ checksum: string }>(
          "SELECT checksum FROM public.business_migrations WHERE package_id=$1 AND migration_id=$2",
          [manifest.id, migration.id],
        )
      ).rows[0];
      if (old) {
        if (old.checksum !== checksum)
          throw new Error("BUSINESS_MIGRATION_CHANGED");
        continue;
      }
      await client.query(`SET LOCAL search_path TO "${schema}",public`);
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO public.business_migrations(package_id,migration_id,checksum,version) VALUES($1,$2,$3,$4)",
        [manifest.id, migration.id, checksum, manifest.version],
      );
    }
    if (
      (
        await client.query(
          "SELECT 1 FROM pg_roles WHERE rolname='cloud_agent_app'",
        )
      ).rowCount
    ) {
      await client.query(
        `GRANT USAGE ON SCHEMA "${schema}" TO cloud_agent_app`,
      );
      await client.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO cloud_agent_app`,
      );
      await client.query(
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO cloud_agent_app`,
      );
    }
  });
}
interface BoundJob {
  id: string;
  job: BusinessJob;
  workspace: string;
  principal: string;
}
export class BusinessJobs {
  private jobs: BoundJob[] = [];
  constructor(
    private db: Database,
    private tasks: TaskStore,
    apps: BusinessApplications,
    deployments: BusinessDeployment[],
  ) {
    for (const deployment of deployments.filter((d) => d.enabled)) {
      const instance = apps.entries.find(
        (e) => e.id === deployment.id,
      )?.instance;
      for (const [id, binding] of Object.entries(deployment.jobs ?? {})) {
        const job = instance?.jobs?.find((j) => j.id === id);
        if (!job) throw new Error("BUSINESS_JOB_NOT_FOUND");
        this.jobs.push({ id: `${deployment.id}:${id}`, job, ...binding });
      }
    }
  }
  async list(workspace: string) {
    const configured = this.jobs.filter((j) => j.workspace === workspace);
    const rows = (
      await this.db.pool.query<{
        id: string;
        config_hash: string;
        enabled: boolean;
        next_at: Date;
      }>("SELECT * FROM business_jobs WHERE id=ANY($1::text[])", [
        configured.map((j) => j.id),
      ])
    ).rows;
    return configured.map((j) => ({
      id: j.id,
      desiredHash: fingerprint(j),
      currentHash: rows.find((r) => r.id === j.id)?.config_hash ?? null,
      enabled: rows.find((r) => r.id === j.id)?.enabled ?? true,
      nextAt: rows.find((r) => r.id === j.id)?.next_at ?? null,
    }));
  }
  async change(actor: Principal, key: string, raw: unknown) {
    const input = JobChange.parse(raw),
      binding = this.jobs.find(
        (j) => j.id === input.id && j.workspace === actor.workspace_id,
      );
    if (!binding) throw new Problem(404, "BUSINESS_JOB_NOT_FOUND");
    await this.db.transaction(async (client) => {
      if (
        !(await governanceCommand(
          client,
          actor,
          "schedule:write",
          key,
          "job",
          input.id,
          input,
        ))
      )
        return;
      const changed = await client.query(
        "UPDATE business_jobs SET config_hash=$2,enabled=$3 WHERE id=$1 AND config_hash=$4",
        [input.id, fingerprint(binding), input.enabled, input.expectedHash],
      );
      if (!changed.rowCount)
        throw new Problem(409, "BUSINESS_JOB_VERSION_CONFLICT");
    });
  }
  async tick() {
    const errors: unknown[] = [];
    for (const binding of this.jobs) {
      try {
        await this.advance(binding);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "BUSINESS_JOBS_FAILED");
  }
  private async advance(binding: BoundJob) {
    const hash = fingerprint(binding);
    await this.db.transaction(async (client) => {
      await client.query(
        "INSERT INTO business_jobs(id,config_hash) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [binding.id, hash],
      );
      const row = (
        await client.query<{
          config_hash: string;
          next_at: Date;
          due: boolean;
          enabled: boolean;
        }>(
          "SELECT *,next_at<=now() AS due FROM business_jobs WHERE id=$1 FOR UPDATE",
          [binding.id],
        )
      ).rows[0]!;
      if (!row.enabled) return;
      if (row.config_hash !== hash)
        throw new Problem(409, "BUSINESS_JOB_CONFIG_CHANGED");
      if (!row.due) return;
      const actor = (
        await client.query<Principal>(
          "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
          [binding.workspace, binding.principal],
        )
      ).rows[0];
      if (!actor) throw new Problem(403, "IDENTITY_REVOKED");
      requireCapability(actor, "schedule:write");
      await this.tasks.createInTransaction(
        client,
        actor,
        binding.job.moduleId,
        binding.job.input,
        `business-job:${binding.id}:${row.next_at.toISOString()}`,
      );
      await client.query(
        "UPDATE business_jobs SET next_at=now()+$2::integer*interval '1 second' WHERE id=$1",
        [binding.id, binding.job.intervalSeconds],
      );
    });
  }
}
