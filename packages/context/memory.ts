/** 显式长期记忆与执行快照分离，读取/写入/删除均限于当前主体且具有期限。 */
import { IdentityService } from "../identity/service.js";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { ContextProvider, ContextDocument } from "./index.js";
export class Memories {
  constructor(private db: Database) {}
  async put(
    actor: Principal,
    namespace: string,
    content: string,
    days: number,
    key: string,
  ) {
    requireCapability(actor, "memory:write");
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(namespace) ||
      !content ||
      content.length > 24000 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    )
      throw new Problem(400, "MEMORY_INVALID");
    return this.db.transaction(async (client) => {
      await this.current(actor, "memory:write", client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify(["memory", actor.workspace_id, actor.id, key]),
      ]);
      const hash = fingerprint({ namespace, content, days });
      const old = (
        await client.query<{ hash: string; memory_id: string }>(
          "SELECT hash,memory_id FROM memory_commands WHERE workspace_id=$1 AND principal_id=$2 AND key=$3",
          [actor.workspace_id, actor.id, key],
        )
      ).rows[0];
      if (old) {
        if (old.hash !== hash) throw new Problem(409, "IDEMPOTENCY_CONFLICT");
        return { id: old.memory_id };
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO agent_memories(id,workspace_id,principal_id,namespace,content,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6::integer*interval '1 day')",
        [id, actor.workspace_id, actor.id, namespace, content, days],
      );
      await client.query("INSERT INTO memory_commands VALUES($1,$2,$3,$4,$5)", [
        actor.workspace_id,
        actor.id,
        key,
        hash,
        id,
      ]);
      return { id };
    });
  }
  async remove(actor: Principal, id: string) {
    requireCapability(actor, "memory:write");
    return this.db.transaction(async (client) => {
      await this.current(actor, "memory:write", client);
      const row = await client.query(
        "UPDATE agent_memories SET content='',deleted_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 AND deleted_at IS NULL",
        [id, actor.workspace_id, actor.id],
      );
      return { removed: Boolean(row.rowCount) };
    });
  }
  private async current(
    actor: Principal,
    capability: string,
    client?: PoolClient,
  ) {
    const current = client
      ? (
          await client.query<Principal>(
            "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
            [actor.workspace_id, actor.id],
          )
        ).rows[0]
      : await new IdentityService(this.db).current(
          actor.workspace_id,
          actor.id,
        );
    if (!current) throw new Problem(403, "IDENTITY_REVOKED");
    requireCapability(current, capability);
    requireCapability(actor, capability);
  }

  provider(): ContextProvider {
    return {
      id: "memory",
      version: "1",
      identity: "postgres:owner-memory:v1",
      capability: "memory:read",
      load: async (query, actor) => {
        await this.current(actor, "memory:read");
        const rows = (
          await this.db.pool.query<{
            id: string;
            content: string;
            version: number;
            expires_at: Date;
          }>(
            "SELECT id,content,version,expires_at FROM agent_memories WHERE workspace_id=$1 AND principal_id=$2 AND namespace=$3 AND deleted_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 20",
            [actor.workspace_id, actor.id, query.namespace],
          )
        ).rows;
        await this.current(actor, "memory:read");
        return rows.map((row) => ({
          id: row.id,
          text: row.content,
          source: { uri: `memory:${row.id}`, version: String(row.version) },
          expiresAt: row.expires_at.toISOString(),
        }));
      },
      authorize: (documents, actor) => this.authorize(documents, actor),
    };
  }
  private async authorize(documents: ContextDocument[], actor: Principal) {
    await this.current(actor, "memory:read");
    for (const document of documents) {
      const result = await this.db.pool.query(
        "SELECT 1 FROM agent_memories WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 AND version=$4 AND deleted_at IS NULL AND expires_at>now()",
        [
          document.id,
          actor.workspace_id,
          actor.id,
          Number(document.source?.version),
        ],
      );
      if (!result.rowCount) throw new Problem(403, "MEMORY_REVOKED");
    }
  }
}
