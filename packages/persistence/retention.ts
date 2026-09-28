/** 正文退役保留任务身份、请求摘要和回执墓碑；未知写入及未完成通知禁止清理。 */
import { Problem } from "../contracts/index.js";
import { lockTaskTree } from "./tasks.js";
import type { Database } from "./database.js";
const eligible = `t.retired_at IS NULL
AND t.status IN ('succeeded','failed','cancelled') AND t.updated_at<now()-$1::integer*interval '1 day'
AND NOT EXISTS(SELECT 1 FROM tool_invocations i WHERE i.task_id=t.id AND i.status IN ('unknown','dispatching'))
AND NOT EXISTS(SELECT 1 FROM model_requests m WHERE (m.task_id=t.id OR m.source_task=t.id) AND m.state IN ('running','cancelling','unknown') AND m.quarantine_until>now())
AND NOT EXISTS(SELECT 1 FROM waits w WHERE w.task_id=t.id AND w.status='pending')
AND NOT EXISTS(SELECT 1 FROM mail_outbox m WHERE (m.task_id=t.id OR m.source_task=t.id) AND m.state NOT IN ('sent','cancelled'))
AND NOT EXISTS(SELECT 1 FROM channel_outbox o WHERE o.task_id=t.id AND o.state NOT IN ('sent','cancelled'))
AND NOT EXISTS(SELECT 1 FROM file_artifacts f WHERE f.task_id=t.id AND f.state NOT IN ('deleted'))`;
export class DataRetention {
  constructor(private db: Database) {}
  async run(days: number, apply: boolean, actor: string) {
    if (!Number.isInteger(days) || days < 1 || days > 3650 || !actor)
      throw new Problem(400, "RETENTION_POLICY_INVALID");
    return this.db.transaction(async (client) => {
      // 整棵任务树作为清理单元，避免父任务保留已删除子结果或跨树恢复。
      const roots = (
        await client.query<{ id: string }>(
          `SELECT t.id FROM tasks t WHERE t.parent_id IS NULL AND ${eligible} ORDER BY t.updated_at LIMIT 100`,
          [days],
        )
      ).rows;
      const rows: { id: string }[] = [];
      for (const root of roots) {
        await lockTaskTree(client, root.id);
        const tree = (
          await client.query<{ id: string; eligible: boolean }>(
            `WITH RECURSIVE tree AS (SELECT id FROM tasks WHERE id=$2 UNION ALL SELECT c.id FROM tasks c JOIN tree p ON c.parent_id=p.id) SELECT t.id,(${eligible}) AS eligible FROM tasks t WHERE t.id IN (SELECT id FROM tree) ORDER BY t.id FOR UPDATE OF t`,
            [days, root.id],
          )
        ).rows;
        if (tree.every((t) => t.eligible)) rows.push(...tree);
      }
      if (!apply) return { candidates: rows.map((r) => r.id), retired: 0 };
      for (const { id } of rows) {
        await client.query(
          "UPDATE tasks SET input='{}',result=NULL,retired_at=now() WHERE id=$1",
          [id],
        );
        await client.query(
          "UPDATE steps SET request='{}',output=NULL WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE messages SET content='{}' WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE waits SET reason='',schema='{}',response=NULL WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE artifacts SET title='Retired',content='null' WHERE task_id=$1",
          [id],
        );
        await client.query("UPDATE events SET data='{}' WHERE task_id=$1", [
          id,
        ]);
        await client.query("DELETE FROM task_archives WHERE task_id=$1", [id]);
        await client.query("DELETE FROM context_snapshots WHERE task_id=$1", [
          id,
        ]);
        await client.query(
          "UPDATE channel_outbox SET payload='{}' WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE channel_inbound SET payload='{}' WHERE task_id=$1 AND state='processed'",
          [id],
        );
        await client.query(
          "UPDATE mail_outbox SET body='',subject='',metadata='{}' WHERE task_id=$1 OR source_task=$1",
          [id],
        );
        await client.query(
          "UPDATE inbound_events SET response='{}' WHERE wait_id IN (SELECT id FROM waits WHERE task_id=$1)",
          [id],
        );
        await client.query(
          "UPDATE external_signals SET response='{}' WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE mail_tasks SET subject='' WHERE task_id=$1",
          [id],
        );
        await client.query(
          "UPDATE conversations SET title='Retired' WHERE id=(SELECT conversation_id FROM tasks WHERE id=$1) AND NOT EXISTS(SELECT 1 FROM tasks WHERE conversation_id=conversations.id AND retired_at IS NULL)",
          [id],
        );
        await client.query(
          "INSERT INTO retention_audit(task_id,policy_days,actor) VALUES($1,$2,$3)",
          [id, days, actor],
        );
      }
      await client.query(
        "UPDATE agent_memories SET content='',deleted_at=coalesce(deleted_at,now()) WHERE expires_at<=now() AND deleted_at IS NULL",
      );
      await client.query(
        "UPDATE identity_email_challenges SET sealed_code='',code_hash='' WHERE expires_at<=now() AND (sealed_code<>'' OR code_hash<>'')",
      );
      await client.query(
        "DELETE FROM identity_email_challenges WHERE created_at<now()-interval '90 days'",
      );
      return { candidates: rows.map((r) => r.id), retired: rows.length };
    });
  }
}
