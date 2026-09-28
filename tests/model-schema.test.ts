import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { compileJsonSchema } from "../packages/contracts/json-schema.js";
import {
  prepareModelRequest,
  validateModelTurn,
} from "../packages/runtime/model-request.js";
import type { ModelEngine } from "../packages/contracts/index.js";

const Plan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), text: z.string() }).strict(),
  z.object({ kind: z.literal("read"), query: z.literal("records") }).strict(),
]);

const turn = {
  text: '{"kind":"answer","text":"你好！"}',
  calls: [],
  costUsd: 0,
  costEstimated: false,
  inputTokens: 0,
  outputTokens: 0,
};
const engine: ModelEngine = {
  id: "schema-fixture",
  capabilities: { structuredOutput: "validated", maxOutputTokens: 2048 },
  next: async () => turn,
};

test("Zod 默认生成的联合 Schema 能进入模型请求，输出仍严格校验", () => {
  const request = prepareModelRequest(
    {
      instructions: "返回结构化意图",
      messages: [{ role: "user", text: "你好" }],
      tools: [],
      outputSchema: z.json().parse(z.toJSONSchema(Plan)),
    },
    engine,
    [],
  );
  assert.deepEqual(validateModelTurn(request, turn).data, {
    kind: "answer",
    text: "你好！",
  });
  for (const text of [
    "你好！",
    '{"kind":"answer","text":42}',
    '{"kind":"answer","text":"你好","approved":true}',
    '{"kind":"read","query":"unknown"}',
  ])
    assert.throws(() => validateModelTurn(request, { ...turn, text }));
});

test("2020-12 的 prefixItems 约束不会被当作 Draft-07 忽略", () => {
  const validate = compileJsonSchema(
    z.toJSONSchema(z.tuple([z.string(), z.number()])),
  );
  assert.equal(validate(["item", 1]), true);
  assert.equal(validate([1, "item"]), false);
  assert.equal(validate(["item", 1, 2]), false);
});

test("缺省及显式 Draft-07 保持兼容，未知方言及远程引用仍拒绝", () => {
  for (const dialect of [
    undefined,
    "http://json-schema.org/draft-07/schema#",
  ]) {
    const validate = compileJsonSchema({
      ...(dialect ? { $schema: dialect } : {}),
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: false,
    });
    assert.equal(validate(["item", 1]), true);
    assert.equal(validate([1, "item"]), false);
  }
  assert.throws(() =>
    compileJsonSchema({ $schema: "https://example.invalid/schema" }),
  );
  assert.throws(() =>
    compileJsonSchema({ $ref: "https://example.invalid/schema" }),
  );
});
