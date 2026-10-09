/** 指标聚合不包含输入、凭据和业务结果；运维身份单独授权。 */
import type { Registry } from "../runtime/registry.js";
import type { Database } from "../persistence/database.js";
export class Operations {
  constructor(
    private db: Database,
    private registry: Registry,
    private pool = "default",
    private labels: string[] = [],
  ) {}
  async loopHeartbeat(id: string, kind: string, error: string | null = null) {
    await this.db.pool.query(
      `INSERT INTO loop_health(id,kind,last_success,error) VALUES($1,$2,CASE WHEN $3::text IS NULL THEN now() END,$3)
    ON CONFLICT(id,kind) DO UPDATE SET seen_at=now(),last_success=CASE WHEN $3::text IS NULL THEN now() ELSE loop_health.last_success END,error=$3`,
      [id, kind, error],
    );
  }
  async heartbeat(id: string) {
    await this.db.pool.query(
      "INSERT INTO worker_heartbeats(id,modules) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET seen_at=now(),modules=EXCLUDED.modules",
      [
        id,
        JSON.stringify(
          this.registry.compatible().filter((m) => {
            const runtime = this.registry.get(m.id, m.version).runtime;
            return (
              (runtime?.pool ?? "default") === this.pool &&
              (runtime?.labels ?? []).every((label) =>
                this.labels.includes(label),
              )
            );
          }),
        ),
      ],
    );
  }
  /** readiness 探测最近心跳及版本覆盖，不把空闲当故障，也不扫描任务明细。 */
  async ready() {
    const row = (
      await this.db.pool.query<{
        worker: boolean;
        maintenance: boolean;
        compatible: boolean;
      }>(
        `SELECT
      EXISTS(SELECT 1 FROM worker_heartbeats WHERE seen_at>now()-interval '30 seconds') AS worker,
      (EXISTS(SELECT 1 FROM loop_health WHERE kind='maintenance' AND error IS NULL AND seen_at>now()-interval '30 seconds') AND NOT EXISTS(SELECT 1 FROM platform_maintenance WHERE enabled)) AS maintenance,
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) m
        WHERE NOT EXISTS(SELECT 1 FROM worker_heartbeats w WHERE w.seen_at>now()-interval '30 seconds' AND w.modules @> jsonb_build_array(m))) AS compatible`,
        [JSON.stringify(this.registry.compatible())],
      )
    ).rows[0]!;
    return { database: true, ...row };
  }
  async pruneHeartbeats() {
    await this.db.pool.query(
      "DELETE FROM worker_heartbeats WHERE seen_at<now()-interval '7 days'",
    );
    await this.db.pool.query(
      "DELETE FROM loop_health WHERE seen_at<now()-interval '7 days'",
    );
  }
  private async backlog(workspace?: string, cluster = false) {
    const queue = (
      await this.db.pool.query<{
        oldest_seconds: number;
        incompatible: string;
      }>(
        `SELECT
      coalesce(max(extract(epoch FROM now()-available_at)),0)::double precision AS oldest_seconds,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS m(id text,version text,hash text)
        WHERE m.id=t.module_id AND m.version=t.module_version AND m.hash=t.config_hash))::text AS incompatible
      FROM tasks t WHERE (t.status IN ('queued','retry_scheduled') OR (t.status='running' AND t.lease_until<now()))
      AND available_at<=now() AND ($1::text IS NULL OR workspace_id=$1)`,
        [workspace ?? null, JSON.stringify(this.registry.compatible())],
      )
    ).rows[0]!;
    const mail = (
      await this.db.pool.query<{ kind: string; state: string; count: string }>(
        `SELECT 'inbound' AS kind,m.state,count(*)::text FROM mail_inbound m JOIN mailboxes b ON b.id=m.mailbox WHERE ($1::text IS NULL OR b.workspace_id=$1) GROUP BY m.state
      UNION ALL SELECT 'outbox',m.state,count(*)::text FROM mail_outbox m JOIN mailboxes b ON b.id=m.mailbox WHERE ($1::text IS NULL OR b.workspace_id=$1) GROUP BY m.state
      UNION ALL SELECT 'mailbox','scan_error',count(*)::text FROM mailboxes WHERE last_error IS NOT NULL AND ($1::text IS NULL OR workspace_id=$1)
      UNION ALL SELECT 'mailbox','blocked',count(*)::text FROM mailboxes WHERE blocked_reason IS NOT NULL AND ($1::text IS NULL OR workspace_id=$1)`,
        [workspace ?? null],
      )
    ).rows;
    const loops =
      workspace && !cluster
        ? []
        : (
            await this.db.pool.query<{
              kind: string;
              healthy: string;
              failed: string;
            }>(`SELECT kind,count(*) FILTER(WHERE error IS NULL AND seen_at>now()-interval '30 seconds')::text AS healthy,
      count(*) FILTER(WHERE error IS NOT NULL OR seen_at<=now()-interval '30 seconds')::text AS failed FROM loop_health GROUP BY kind`)
          ).rows;
    const mailAccounts = (
      await this.db.pool.query<{
        id: string;
        provider: string;
        blocked: boolean;
        scan_error: boolean;
        kind: string;
        healthy: boolean;
      }>(
        `SELECT b.id,b.provider,b.blocked_reason IS NOT NULL AS blocked,b.last_error IS NOT NULL AS scan_error,
      k.kind,COALESCE(h.error IS NULL AND h.seen_at>now()-interval '120 seconds',false) AS healthy
      FROM mailboxes b CROSS JOIN (VALUES ('receive'),('notify'),('send')) AS k(kind)
      LEFT JOIN mail_health h ON h.mailbox=b.id AND h.kind=k.kind
      WHERE ($1::text IS NULL OR b.workspace_id=$1) ORDER BY b.id,k.kind`,
        [workspace ?? null],
      )
    ).rows;
    return { queue, mail, loops, mailAccounts };
  }
  async snapshot(workspace?: string, cluster = false) {
    const counts = (
      await this.db.pool.query<{ status: string; count: string }>(
        "SELECT status,count(*)::text FROM tasks WHERE ($1::text IS NULL OR workspace_id=$1) GROUP BY status",
        [workspace ?? null],
      )
    ).rows;
    const unknown = (
      await this.db.pool.query<{ count: string }>(
        "SELECT count(*)::text FROM tool_invocations i JOIN tasks t ON t.id=i.task_id WHERE i.status IN ('unknown','dispatching') AND ($1::text IS NULL OR t.workspace_id=$1)",
        [workspace ?? null],
      )
    ).rows[0]!.count;
    const workers =
      workspace && !cluster
        ? []
        : (
            await this.db.pool.query<{ id: string; seen_at: Date }>(
              "SELECT * FROM worker_heartbeats WHERE seen_at>now()-interval '30 seconds'",
            )
          ).rows;
    const usage = (
      await this.db.pool.query(
        "SELECT coalesce(sum(model_calls-coalesce(g.models,0)),0)::text AS model_calls,coalesce(sum(tool_calls-coalesce(g.tools,0)),0)::text AS tool_calls,coalesce(sum(cost_usd-coalesce(g.cost,0)),0) AS cost_usd FROM tasks t LEFT JOIN LATERAL (SELECT sum((usage->>'model_calls')::integer) AS models,sum((usage->>'tool_calls')::integer) AS tools,sum((usage->>'cost_usd')::double precision) AS cost FROM task_groups WHERE parent_id=t.id) g ON true WHERE ($1::text IS NULL OR workspace_id=$1)",
        [workspace ?? null],
      )
    ).rows[0];
    return {
      clusterVisible: !workspace || cluster,
      counts,
      unknown,
      workers,
      usage,
      ...(await this.backlog(workspace, cluster)),
    };
  }
  private async extensionMetrics(workspace?: string) {
    const channels = await this.db.pool.query<{ state: string; count: string }>(
      "SELECT o.state,count(*)::text FROM channel_outbox o JOIN channel_accounts a ON a.id=o.account WHERE ($1::text IS NULL OR a.workspace_id=$1) GROUP BY o.state",
      [workspace ?? null],
    );
    const files = await this.db.pool.query<{
      count: string;
      bytes: string;
      expired: string;
    }>(
      "SELECT count(*)::text,coalesce(sum(f.bytes),0)::text AS bytes,count(*) FILTER(WHERE f.expires_at<=now())::text AS expired FROM file_artifacts f JOIN tasks t ON t.id=f.task_id WHERE ($1::text IS NULL OR t.workspace_id=$1)",
      [workspace ?? null],
    );
    const active = await this.db.pool.query<{
      module_id: string;
      count: string;
    }>(
      "SELECT module_id,count(*)::text FROM tasks WHERE status='running' AND lease_until>now() AND ($1::text IS NULL OR workspace_id=$1) GROUP BY module_id",
      [workspace ?? null],
    );
    const model = (
      await this.db.pool.query<{ state: string; count: string }>(
        "SELECT m.state,count(*)::text FROM model_requests m JOIN tasks t ON t.id=m.task_id WHERE ($1::text IS NULL OR t.workspace_id=$1) AND m.quarantine_until>now() GROUP BY m.state",
        [workspace ?? null],
      )
    ).rows;
    return [
      ...model.map(
        (r) =>
          `cloud_agent_model_requests{state=${JSON.stringify(r.state)}} ${r.count}`,
      ),
      ...channels.rows.map(
        (row) =>
          `cloud_agent_channel_outbox{state=${JSON.stringify(row.state)}} ${row.count}`,
      ),
      `cloud_agent_files ${files.rows[0]!.count}`,
      `cloud_agent_file_bytes ${files.rows[0]!.bytes}`,
      `cloud_agent_files_expired ${files.rows[0]!.expired}`,
      ...active.rows.map(
        (row) =>
          `cloud_agent_active_leases{module=${JSON.stringify(row.module_id)}} ${row.count}`,
      ),
    ];
  }
  async metrics(workspace?: string, cluster = false) {
    const snapshot = await this.snapshot(workspace, cluster);
    return [
      "# TYPE cloud_agent_tasks gauge",
      ...(await this.extensionMetrics(workspace)),
      ...snapshot.counts.map(
        (row) => `cloud_agent_tasks{status="${row.status}"} ${row.count}`,
      ),
      `cloud_agent_unknown_invocations ${snapshot.unknown}`,
      ...(snapshot.clusterVisible
        ? [`cloud_agent_workers ${snapshot.workers.length}`]
        : []),
      `cloud_agent_model_calls ${snapshot.usage.model_calls}`,
      `cloud_agent_tool_calls ${snapshot.usage.tool_calls}`,
      `cloud_agent_cost_usd ${snapshot.usage.cost_usd}`,
      `cloud_agent_queue_oldest_seconds ${snapshot.queue.oldest_seconds}`,
      `cloud_agent_tasks_incompatible ${snapshot.queue.incompatible}`,
      ...snapshot.mail.map(
        (row) =>
          `cloud_agent_mail{kind="${row.kind}",state="${row.state}"} ${row.count}`,
      ),
      ...snapshot.mailAccounts.flatMap((row) => [
        `cloud_agent_mail_account_healthy{account=${JSON.stringify(row.id)},kind="${row.kind}"} ${Number(row.healthy)}`,
        ...(row.kind === "receive"
          ? [
              `cloud_agent_mail_account_blocked{account=${JSON.stringify(row.id)}} ${Number(row.blocked)}`,
              `cloud_agent_mail_account_scan_error{account=${JSON.stringify(row.id)}} ${Number(row.scan_error)}`,
            ]
          : []),
      ]),
      ...snapshot.loops.flatMap((row) => [
        `cloud_agent_loops{kind="${row.kind}",state="healthy"} ${row.healthy}`,
        `cloud_agent_loops{kind="${row.kind}",state="failed"} ${row.failed}`,
      ]),
      "",
    ].join("\n");
  }
}
