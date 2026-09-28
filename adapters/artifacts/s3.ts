/** S3 兼容适配器使用服务端读取，不生成绕过权限/撤权的公开下载地址。 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  type ArtifactStore,
  objectKey,
  MAX_FILE_BYTES,
  fileDigest,
} from "../../packages/artifacts/index.js";
import { Problem } from "../../packages/contracts/index.js";
export class S3Artifacts implements ArtifactStore {
  constructor(
    private client: S3Client,
    private bucket: string,
    readonly id: string,
    readonly identity = `s3:${bucket}`,
  ) {}
  async put(key: string, data: Buffer, signal: AbortSignal) {
    if (data.length > MAX_FILE_BYTES)
      throw new Problem(413, "ARTIFACT_TOO_LARGE");
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey(key),
          Body: data,
          IfNoneMatch: "*",
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "PreconditionFailed")
        throw error;
      if (fileDigest(await this.get(key, signal)) !== fileDigest(data))
        throw new Problem(409, "ARTIFACT_CONTENT_CHANGED");
    }
  }
  async get(key: string, signal: AbortSignal) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(key) }),
      { abortSignal: signal },
    );
    if (!result.Body) throw new Problem(404, "ARTIFACT_NOT_FOUND");
    const stream = result.Body.transformToWebStream(),
      reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const row = await reader.read();
        if (row.done) break;
        size += row.value.byteLength;
        if (size > MAX_FILE_BYTES) throw new Problem(413, "ARTIFACT_TOO_LARGE");
        chunks.push(row.value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel();
    }
  }
  async remove(key: string, signal: AbortSignal) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(key) }),
      { abortSignal: signal },
    );
  }
  async close() {
    this.client.destroy();
  }
}
