/** 治理写命令在调用者事务中校验当前授权、幂等摘要并记录审计。 */
import type { PoolClient } from "pg";
import {
  Problem,
  requireCapability,
  type Principal,
} from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
export async function governanceCommand(
  client: PoolClient,
  actor: Principal,
  capability: string,
  key: string,
  kind: string,
  target: string,
  input: { reason: string },
) {
  if (!key || key.length > 180)
    throw new Problem(400, "IDEMPOTENCY_KEY_INVALID");
  const current = (
    await client.query<Principal>(
      "SELECT * FROM runtime_lock_principals($1,ARRAY[$2])",
      [actor.workspace_id, actor.id],
    )
  ).rows[0];
  if (!current) throw new Problem(403, "IDENTITY_REVOKED");
  requireCapability(current, capability);
  requireCapability(actor, capability);
  const hash = fingerprint({ kind, target, input });
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    JSON.stringify(["governance", actor.workspace_id, key]),
  ]);
  const old = (
    await client.query<{ request_hash: string; principal_id: string }>(
      "SELECT request_hash,principal_id FROM governance_commands WHERE workspace_id=$1 AND command_key=$2",
      [actor.workspace_id, key],
    )
  ).rows[0];
  if (old) {
    if (old.request_hash !== hash || old.principal_id !== actor.id)
      throw new Problem(409, "IDEMPOTENCY_CONFLICT");
    return false;
  }
  await client.query(
    "INSERT INTO governance_commands(workspace_id,command_key,request_hash,principal_id,kind,target,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [actor.workspace_id, key, hash, actor.id, kind, target, input.reason],
  );
  return true;
}
