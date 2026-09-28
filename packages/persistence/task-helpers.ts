import type { PoolClient } from "pg";
import {
  Problem,
  type Json,
  type Principal,
  type Task,
} from "../contracts/index.js";

export async function event(
  client: PoolClient,
  taskId: string,
  type: string,
  data: Json = {},
): Promise<void> {
  await client.query("INSERT INTO events(task_id,type,data) VALUES($1,$2,$3)", [
    taskId,
    type,
    JSON.stringify(data),
  ]);
}

export async function ownedTask(
  client: PoolClient,
  principal: Principal,
  id: string,
  lock = false,
): Promise<Task> {
  const task = (
    await client.query<Task>(
      `SELECT * FROM tasks WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [id, principal.workspace_id, principal.id],
    )
  ).rows[0];
  if (!task) throw new Problem(404, "TASK_NOT_FOUND");
  return task;
}

/** Tree locks precede row locks so cancellation cannot miss a concurrently added descendant. */
export async function lockTaskTree(client: PoolClient, id: string) {
  const root = (
    await client.query<{ id: string }>(
      "WITH RECURSIVE parents AS (SELECT id,parent_id,1 AS depth FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,p.depth+1 FROM tasks t JOIN parents p ON t.id=p.parent_id) SELECT id FROM parents ORDER BY depth DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  if (root)
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `task-tree:${root.id}`,
    ]);
}
