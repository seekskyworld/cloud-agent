/** 本地对象仅使用摘要键，拒绝符号链接和路径穿越；重复写核对内容，不覆盖已有文件。 */
import { mkdir, open, unlink, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import {
  ArtifactStore,
  objectKey,
  MAX_FILE_BYTES,
  fileDigest,
} from "../../packages/artifacts/index.js";
import { Problem } from "../../packages/contracts/index.js";
export class LocalArtifacts implements ArtifactStore {
  readonly id: string;
  private root: string;
  readonly identity: string;
  constructor(directory: string, id = "local") {
    this.root = resolve(directory);
    this.id = id;
    this.identity = `local:${this.root}`;
  }
  private path(key: string) {
    return join(this.root, objectKey(key));
  }
  async put(key: string, data: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    if (data.length > MAX_FILE_BYTES)
      throw new Problem(413, "ARTIFACT_TOO_LARGE");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.pending-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      signal.throwIfAborted();
      try {
        await link(temporary, this.path(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (fileDigest(await this.get(key, signal)) !== fileDigest(data))
          throw new Problem(409, "ARTIFACT_CONTENT_CHANGED");
      }
    } finally {
      await handle.close();
      await unlink(temporary);
    }
  }

  async get(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const handle = await open(
      this.path(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new Problem(413, "ARTIFACT_TOO_LARGE");
      const buffer = Buffer.alloc(info.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal.throwIfAborted();
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES)
        throw new Problem(413, "ARTIFACT_TOO_LARGE");
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  async remove(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
