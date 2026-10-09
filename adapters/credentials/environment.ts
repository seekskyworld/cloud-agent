/** 共用只读秘密供应器；每次打开同一引用文件的新 inode，错误不带路径或秘密。 */
import { open } from "node:fs/promises";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import type { SecretProvider } from "../../packages/connections/index.js";
export function environmentSecrets(options: {
  json?: string;
  file?: string;
}): SecretProvider {
  return async (reference, signal) => {
    try {
      signal?.throwIfAborted();
      let raw = options.json ?? "{}";
      if (options.file) {
        const handle = await open(options.file, "r");
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.size > 100_000 ||
            (info.mode & 0o077) !== 0
          )
            throw new Error("unsafe");
          const buffer = Buffer.alloc(100_001);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 100_000) throw new Error("large");
          raw = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      }
      signal?.throwIfAborted();
      const values = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
      return z.record(z.string(), z.unknown()).parse(values[reference]);
    } catch {
      throw new Problem(503, "CREDENTIAL_UNAVAILABLE");
    }
  };
}
