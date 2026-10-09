/** 会话历史只是引用数据；不自动把旧请求当成本轮指令。 */
import type { Database } from "../persistence/database.js";
import type { TaskService } from "./service.js";
import {
  Problem,
  type Principal,
  type Data,
  type Json,
} from "../contracts/index.js";
export class ConversationContext {
  constructor(
    private db: Database,
    private tasks: TaskService,
  ) {}
  async read(principal: Principal, taskId: string, limit = 12) {
    const current = await this.tasks.get(principal, taskId);
    const candidates = await this.db.pool.query<{
      id: string;
      input: Data;
      result: Json;
    }>(
      `SELECT id,input,result FROM tasks WHERE conversation_id=$1 AND status='succeeded'
       AND (created_at,id)<(SELECT created_at,id FROM tasks WHERE id=$2)
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [current.conversation_id, taskId, Math.max(1, Math.min(24, limit))],
    );
    const history: { taskId: string; input: Data; result: Json }[] = [];
    let size = 0;
    for (const row of candidates.rows) {
      // 当前领域 ACL 不通过就不把该记录交给模型，不能靠旧角色延续授权。
      try {
        await this.tasks.get(principal, row.id);
      } catch (error) {
        if (error instanceof Problem && [403, 404, 410].includes(error.status))
          continue;
        throw error;
      }
      const value = { taskId: row.id, input: row.input, result: row.result };
      const length = JSON.stringify(value).length;
      if (length > 12000 || size + length > 24000) continue;
      size += length;
      history.unshift(value);
    }
    return history;
  }
}
