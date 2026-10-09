/** 原文摘要与行范围协议；不执行模型调用，不推断业务覆盖范围。 */
import { z } from "zod";

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** 无 Node 依赖的 SHA-256，确保 SDK 在浏览器和独立 TypeScript 工程中可用。 */
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const state: number[] = [...INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotateRight(words[i - 15]!, 7) ^
        rotateRight(words[i - 15]!, 18) ^
        (words[i - 15]! >>> 3);
      const s1 =
        rotateRight(words[i - 2]!, 17) ^
        rotateRight(words[i - 2]!, 19) ^
        (words[i - 2]! >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const temp1 = (h + s1 + choice + ROUND_CONSTANTS[i]! + words[i]!) >>> 0;
      const temp2 = (s0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [
        g,
        f,
        e,
        (d + temp1) >>> 0,
        c,
        b,
        a,
        (temp1 + temp2) >>> 0,
      ];
    }
    for (let i = 0; i < 8; i++)
      state[i] = (state[i]! + [a, b, c, d, e, f, g, h][i]!) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** 文档提取只保存可复核的原文范围；平台不替业务猜测或静默截断内容。 */
export const SourceRange = z
  .object({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .strict()
  .refine((range) => range.endLine >= range.startLine, "SOURCE_RANGE_INVALID");
export type SourceRange = z.infer<typeof SourceRange>;

export const ExtractedReference = z
  .object({
    label: z.string().min(1).max(200),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ranges: z.array(SourceRange).min(1).max(128),
  })
  .strict();
export type ExtractedReference = z.infer<typeof ExtractedReference>;

export function sourceDigest(source: string): string {
  return sha256(source);
}

/** 按 1-based 闭区间提取，换行统一为 LF；full 模式要求每一行恰好覆盖一次。 */
export function restoreSourceRanges(
  source: string,
  digest: string,
  ranges: readonly SourceRange[],
  options: { coverage?: "partial" | "full" } = {},
): string {
  if (sourceDigest(source) !== digest)
    throw new Error("SOURCE_DIGEST_MISMATCH");
  const parsed = z.array(SourceRange).min(1).max(128).safeParse(ranges);
  if (!parsed.success) throw new Error("SOURCE_RANGE_INVALID");
  const lines = source.split(/\r\n|\n|\r/);
  const ordered = parsed.data.sort((a, b) => a.startLine - b.startLine);
  let previousEnd = 0;
  for (const range of ordered) {
    if (range.startLine <= previousEnd || range.endLine > lines.length)
      throw new Error("SOURCE_RANGE_INVALID");
    if (options.coverage === "full" && range.startLine !== previousEnd + 1)
      throw new Error("SOURCE_COVERAGE_INCOMPLETE");
    previousEnd = range.endLine;
  }
  if (options.coverage === "full" && previousEnd !== lines.length)
    throw new Error("SOURCE_COVERAGE_INCOMPLETE");
  return ordered
    .flatMap((range) => lines.slice(range.startLine - 1, range.endLine))
    .join("\n");
}
