/** 测试专用外部副作用替身；独立回执表模拟写入成功但运行时尚未保存结果的故障窗口。 */
import { z } from "zod";
import {
  Problem,
  requireCapability,
  type Data,
  type ExecutionContext,
  type Module,
  type Outcome,
} from "../../packages/contracts/index.js";
import {
  fingerprint,
  type Database,
} from "../../packages/persistence/database.js";
const inputSchema = z.object({ value: z.number().int() }).strict();
export async function prepareEffects(db: Database) {
  await db.pool.query(
    "CREATE TABLE IF NOT EXISTS fixture_effects(id text PRIMARY KEY, request_hash text NOT NULL, result jsonb NOT NULL)",
  );
}
export async function applyEffect(
  db: Database,
  input: Data,
  context: ExecutionContext,
): Promise<Outcome> {
  requireCapability(context.principal, "effect:write");
  const value = inputSchema.parse(input);
  const hash = fingerprint({
    input: value,
    workspace: context.principal.workspace_id,
    principal: context.principal.id,
  });
  return db.transaction(async (client) => {
    await client.query(
      "INSERT INTO fixture_effects(id,request_hash,result) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [context.idempotencyKey, hash, JSON.stringify(value)],
    );
    const row = (
      await client.query(
        "SELECT request_hash,result FROM fixture_effects WHERE id=$1",
        [context.idempotencyKey],
      )
    ).rows[0];
    if (row.request_hash !== hash) throw new Problem(409, "EFFECT_CONFLICT");
    return {
      kind: "succeeded",
      output: row.result,
      receipt: context.idempotencyKey,
    };
  });
}
export function effectModule(db: Database): Module {
  return {
    id: "effect",
    version: "1",
    title: "测试副作用",
    description: "仅测试注册",
    capability: "report:run",
    input: inputSchema,
    example: { value: 10 },
    tools: [
      {
        name: "effect.apply",
        version: "1",
        description: "确认后写入测试回执",
        input: inputSchema,
        output: inputSchema,
        capability: "effect:write",
        effect: "idempotent_write",
        approval: true,
        timeoutMs: 1000,
        execute: (input, context) => applyEffect(db, input, context),
      },
    ],
    next(input, steps) {
      return steps.length
        ? { kind: "complete", result: steps[0]!.output! }
        : { kind: "tool", key: "effect", name: "effect.apply", input };
    },
  };
}
