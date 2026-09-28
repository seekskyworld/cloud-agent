/** 压缩执行轨迹，不删除任务/幂等/回执/审计；显式运维命令才执行归档。 */
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { Problem, type Json } from "../contracts/index.js";
const compress = promisify(gzip),
  expand = promisify(gunzip);
export type StoredEvent = {
  id: string;
  task_id: string;
  type: string;
  data: Json;
  created_at: Date | string;
};
type Archived = {
  version: 1;
  events: StoredEvent[];
  attempts: Record<string, unknown>[];
};
function checksum(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}
export async function readArchives(
  client: PoolClient,
  taskId: string,
): Promise<Archived[]> {
  const rows = (
    await client.query<{ payload: Buffer; checksum: string }>(
      "SELECT payload,checksum FROM task_archives WHERE task_id=$1 ORDER BY id",
      [taskId],
    )
  ).rows;
  return Promise.all(
    rows.map(async (row) => {
      if (checksum(row.payload) !== row.checksum)
        throw new Problem(500, "ARCHIVE_CORRUPTED");
      const data = JSON.parse(
        (
          await expand(row.payload, { maxOutputLength: 32 * 1024 * 1024 })
        ).toString(),
      ) as Archived;
      if (data.version !== 1)
        throw new Problem(500, "ARCHIVE_VERSION_UNSUPPORTED");
      return data;
    }),
  );
}
const eligible = `t.status IN ('succeeded','failed','cancelled') AND t.updated_at<now()-$1::int*interval '1 day'
 AND NOT EXISTS(SELECT 1 FROM tool_invocations i WHERE i.task_id=t.id AND i.status IN ('unknown','dispatching'))
 AND NOT EXISTS(SELECT 1 FROM waits w WHERE w.task_id=t.id AND w.status='pending')
 AND NOT EXISTS(SELECT 1 FROM mail_outbox o WHERE o.task_id=t.id AND o.state NOT IN ('sent','cancelled'))
 AND NOT EXISTS(SELECT 1 FROM channel_outbox o WHERE o.task_id=t.id AND o.state NOT IN ('sent','cancelled'))
 AND NOT EXISTS(SELECT 1 FROM mail_inbound m WHERE m.task_id=t.id AND m.state<>'processed')
 AND (EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id) OR EXISTS(SELECT 1 FROM invocation_attempts a JOIN steps s ON s.id=a.step_id WHERE s.task_id=t.id))`;
export class ArchiveStore {
  constructor(private db: Database) {}
  async run(options: {
    retentionDays: number;
    batchSize: number;
    apply: boolean;
  }) {
    if (
      !Number.isInteger(options.retentionDays) ||
      options.retentionDays < 1 ||
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 100
    )
      throw new Problem(400, "INVALID_RETENTION_POLICY");
    return this.db.transaction(async (client) => {
      const rows = (
        await client.query<{ id: string }>(
          `SELECT t.id FROM tasks t WHERE ${eligible} ORDER BY t.updated_at,t.id LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,
          [options.retentionDays, options.batchSize],
        )
      ).rows;
      if (!options.apply)
        return { candidates: rows.map((r) => r.id), archived: 0 };
      let archived = 0;
      for (const row of rows)
        if (await this.archive(client, row.id)) archived++;
      return { candidates: rows.map((r) => r.id), archived };
    });
  }
  private async archive(client: PoolClient, id: string) {
    // 与 Worker 同样锁任务行；失败重试和轨迹读取得到完整的归档前或归档后视图。
    const events = (
      await client.query<StoredEvent>(
        "SELECT id::text,task_id,type,data,created_at FROM events WHERE task_id=$1 ORDER BY events.id LIMIT 10000",
        [id],
      )
    ).rows;
    const attempts = (
      await client.query<Record<string, unknown>>(
        "SELECT a.* FROM invocation_attempts a JOIN steps s ON s.id=a.step_id WHERE s.task_id=$1 ORDER BY a.id LIMIT 10000",
        [id],
      )
    ).rows;
    const json = Buffer.from(JSON.stringify({ version: 1, events, attempts }));
    if (json.length > 32 * 1024 * 1024)
      throw new Problem(422, "ARCHIVE_BATCH_TOO_LARGE");
    if (!events.length && !attempts.length) return false;
    const payload = await compress(json);
    await client.query(
      "INSERT INTO task_archives(task_id,payload,checksum,event_count,attempt_count) VALUES($1,$2,$3,$4,$5)",
      [id, payload, checksum(payload), events.length, attempts.length],
    );
    await client.query("DELETE FROM events WHERE id=ANY($1::bigint[])", [
      events.map((e) => e.id),
    ]);
    await client.query(
      "DELETE FROM invocation_attempts WHERE id=ANY($1::bigint[])",
      [attempts.map((a) => a.id)],
    );
    return true;
  }
}
