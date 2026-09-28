/** 配额和公平性跨 Worker 共享；固定一分钟窗口仅控制准入，不重试外部写入。 */
import type { Database } from "../persistence/database.js";
export interface DispatchPolicy {
  queueLimit?: number;
  workspaceConcurrency?: number;
  workspaces?: Record<string, number>;
  modules?: Record<string, number>;
}
export async function admitConnection(db: Database, id: string, limit: number) {
  const result = await db.pool.query(
    `INSERT INTO connection_rates(id,window_start,count) VALUES($1,date_trunc('minute',now()),1)
    ON CONFLICT(id) DO UPDATE SET window_start=date_trunc('minute',now()),count=CASE WHEN connection_rates.window_start<date_trunc('minute',now()) THEN 1 ELSE connection_rates.count+1 END
    WHERE connection_rates.window_start<date_trunc('minute',now()) OR connection_rates.count<$2 RETURNING count`,
    [id, limit],
  );
  return !!result.rowCount;
}
