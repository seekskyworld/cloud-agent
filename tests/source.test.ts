/** SDK 原文完整性协议以已知摘要和非法输入验证，调用方不能只依赖 TypeScript 类型。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  restoreSourceRanges,
  sourceDigest,
} from "../packages/contracts/source.js";
import { failureOutcome } from "../packages/contracts/failure.js";
import { Problem } from "../packages/contracts/index.js";

test("跨运行时摘要与标准 SHA-256 一致", () => {
  for (const value of [
    "",
    "abc",
    "中文🙂\r\n正文",
    ...[55, 56, 63, 64, 65, 1000].map((n) => "x".repeat(n)),
  ])
    assert.equal(
      sourceDigest(value),
      createHash("sha256").update(value).digest("hex"),
    );
});
test("范围直接调用拒绝倒置、小数、非有限值、空集合、越界和重叠", () => {
  const source = "a\nb\nc",
    digest = sourceDigest(source);
  for (const ranges of [
    [],
    [{ startLine: 2, endLine: 1 }],
    [{ startLine: 1.5, endLine: 2 }],
    [{ startLine: 0, endLine: 1 }],
    [{ startLine: 1, endLine: Infinity }],
    [{ startLine: NaN, endLine: 1 }],
    [{ startLine: 1, endLine: 4 }],
    [
      { startLine: 1, endLine: 2 },
      { startLine: 2, endLine: 3 },
    ],
  ])
    assert.throws(
      () => restoreSourceRanges(source, digest, ranges),
      /SOURCE_RANGE_INVALID/,
    );
  assert.throws(
    () =>
      restoreSourceRanges(source, "changed", [{ startLine: 1, endLine: 1 }]),
    /SOURCE_DIGEST_MISMATCH/,
  );
});
test("全文模式拒绝首尾和中间遗漏，局部摘录仍兼容并规范换行", () => {
  const source = "a\r\nb\rc\n",
    digest = sourceDigest(source);
  for (const ranges of [
    [{ startLine: 2, endLine: 4 }],
    [{ startLine: 1, endLine: 3 }],
    [
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
    ],
  ])
    assert.throws(
      () => restoreSourceRanges(source, digest, ranges, { coverage: "full" }),
      /SOURCE_COVERAGE_INCOMPLETE/,
    );
  assert.equal(
    restoreSourceRanges(
      source,
      digest,
      [
        { startLine: 3, endLine: 4 },
        { startLine: 1, endLine: 2 },
      ],
      { coverage: "full" },
    ),
    "a\nb\nc\n",
  );
  assert.equal(
    restoreSourceRanges(source, digest, [{ startLine: 2, endLine: 2 }]),
    "b",
  );
});
test("通用工具超时保留领域错误码", () => {
  for (const status of [408, 425, 504]) {
    const outcome = failureOutcome(
      new Problem(status, "UPSTREAM_TIMEOUT"),
      "read",
      "ref",
      "UNKNOWN",
    );
    assert.equal(outcome.kind, "retryable");
    assert.ok("code" in outcome && outcome.code === "UPSTREAM_TIMEOUT");
  }
});
