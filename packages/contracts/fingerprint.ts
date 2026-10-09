import { createHash } from "node:crypto";
import { canonical } from "./index.js";

/** Stable hashes are protocol data; keeping the implementation here avoids coupling callers to PostgreSQL. */
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const tokenHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
