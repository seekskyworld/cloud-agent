/** 下载按持久元数据选择已注册存储，不能由客户端选择桶或目录。 */
import type { Database } from "../persistence/database.js";
import { Problem, type Principal } from "../contracts/index.js";
import type { ArtifactFiles } from "./index.js";
export class FileDownloads {
  constructor(
    private db: Database,
    private stores: Map<string, ArtifactFiles>,
  ) {}
  async get(actor: Principal, id: string) {
    const row = (
      await this.db.pool.query<{ store_id: string }>(
        "SELECT f.store_id FROM file_artifacts f JOIN tasks t ON t.id=f.task_id WHERE f.id=$1 AND t.workspace_id=$2 AND t.principal_id=$3",
        [id, actor.workspace_id, actor.id],
      )
    ).rows[0];
    if (!row) throw new Problem(404, "TASK_NOT_FOUND");
    const files = this.stores.get(row.store_id);
    if (!files) throw new Problem(503, "ARTIFACT_STORE_DISABLED");
    return files.get(actor, id);
  }
}
