/** 测试专用存储：用幂等回执和版本比较验证真实数据库下的包贡献，不进入宿主装配。 */
import type { z } from "zod";
import {
  type Database,
  fingerprint,
} from "../../packages/persistence/database.js";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../../packages/contracts/index.js";
import {
  recordsPort,
  type Records,
  type RecordValue,
  type RecordCommand,
} from "./records-package.js";
export function recordsBinding(db: Database) {
  return {
    token: recordsPort.id,
    version: recordsPort.version,
    identity: "fixture:records:v1",
    value: new RecordStore(db),
  };
}
class RecordStore implements Records {
  constructor(private db: Database) {}
  async list(actor: Principal) {
    requireCapability(actor, "fixture:read");
    return (
      await this.db.pool.query<RecordValue>(
        "SELECT id,value,version FROM business_fixture_records.records WHERE workspace_id=$1 ORDER BY id",
        [actor.workspace_id],
      )
    ).rows;
  }
  write(actor: Principal, input: z.infer<typeof RecordCommand>, key: string) {
    return this.db.transaction(async (client) => {
      const current = (
        await client.query<Principal>(
          "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
          [actor.workspace_id, actor.id],
        )
      ).rows[0];
      if (!current) throw new Problem(403, "IDENTITY_REVOKED");
      requireCapability(current, "fixture:write");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify([actor.workspace_id, actor.id, key]),
      ]);
      const hash = fingerprint(input);
      const previous = (
        await client.query<{ hash: string; result: RecordValue }>(
          "SELECT hash,result FROM business_fixture_records.commands WHERE workspace_id=$1 AND principal_id=$2 AND key=$3",
          [actor.workspace_id, actor.id, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.hash !== hash)
          throw new Problem(409, "IDEMPOTENCY_CONFLICT");
        return previous.result;
      }
      const values = [
        actor.workspace_id,
        input.id,
        input.value,
        input.expectedVersion,
      ];
      const row =
        input.expectedVersion === 0
          ? (
              await client.query<RecordValue>(
                "INSERT INTO business_fixture_records.records VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING RETURNING id,value,version",
                values.slice(0, 3),
              )
            ).rows[0]
          : (
              await client.query<RecordValue>(
                "UPDATE business_fixture_records.records SET value=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING id,value,version",
                values,
              )
            ).rows[0];
      if (!row) throw new Problem(409, "RECORD_VERSION_CONFLICT");
      await client.query(
        "INSERT INTO business_fixture_records.commands VALUES($1,$2,$3,$4,$5)",
        [actor.workspace_id, actor.id, key, hash, JSON.stringify(row)],
      );
      return row;
    });
  }
}
