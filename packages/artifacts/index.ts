/** 大文件与任务 JSON 分离；对象不可变，重复工具调用复用元数据，下载始终复核当前权限。 */
import { abortable } from "../contracts/lifecycle.js";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  Problem,
  type Principal,
  type ExecutionContext,
} from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { Database } from "../persistence/database.js";
import type { TaskService } from "../runtime/service.js";
export interface ArtifactStore {
  id: string;
  /** 必须绑定物理位置；自定义实现变更位置时更换 identity。 */
  identity: string;
  put(key: string, data: Buffer, signal: AbortSignal): Promise<void>;
  get(key: string, signal: AbortSignal): Promise<Buffer>;
  remove(key: string, signal: AbortSignal): Promise<void>;
  close?: () => Promise<void>;
}
export const fileDigest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const MAX_FILE_BYTES = 10_000_000;
export function objectKey(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Problem(400, "ARTIFACT_KEY_INVALID");
  return key;
}
interface FileRow {
  id: string;
  task_id: string;
  name: string;
  media_type: string;
  bytes: number;
  digest: string;
  object_key: string;
  store_id: string;
  state: string;
  expired: boolean;
}
export class ArtifactFiles {
  constructor(
    private db: Database,
    private tasks: TaskService,
    readonly store: ArtifactStore,
    private retentionDays = 30,
  ) {}
  private async initialize() {
    const result = await this.db.pool.query(
      "INSERT INTO artifact_stores(id,identity_hash) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE artifact_stores.identity_hash=EXCLUDED.identity_hash RETURNING id",
      [this.store.id, fingerprint(this.store.identity)],
    );
    if (!result.rowCount) throw new Problem(409, "ARTIFACT_STORE_CHANGED");
  }
  async put(
    context: ExecutionContext,
    name: string,
    mediaType: string,
    data: Buffer,
  ) {
    if (
      !/^[\p{L}\p{N}_. -]{1,120}$/u.test(name) ||
      name === "." ||
      name === ".." ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)
    )
      throw new Problem(400, "ARTIFACT_METADATA_INVALID");
    if (data.length > MAX_FILE_BYTES)
      throw new Problem(413, "ARTIFACT_TOO_LARGE");
    await this.tasks.get(context.principal, context.taskId);
    const digest = fileDigest(data),
      key = fileDigest(
        Buffer.from(
          `${context.taskId}:${context.invocationId}:${name}:${digest}`,
        ),
      );
    await this.initialize();
    const row = (
      await this.db.pool.query<FileRow>(
        `INSERT INTO file_artifacts(id,task_id,invocation_id,name,media_type,bytes,digest,object_key,store_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10*interval '1 day')
      ON CONFLICT(task_id,invocation_id,name) DO UPDATE SET name=EXCLUDED.name,writing_until=now()+interval '1 minute'
      WHERE file_artifacts.digest=EXCLUDED.digest AND file_artifacts.media_type=EXCLUDED.media_type AND file_artifacts.store_id=EXCLUDED.store_id AND file_artifacts.expires_at>now() AND file_artifacts.state<>'deleting'
      RETURNING *`,
        [
          randomUUID(),
          context.taskId,
          context.invocationId,
          name,
          mediaType,
          data.length,
          digest,
          key,
          this.store.id,
          this.retentionDays,
        ],
      )
    ).rows[0];
    if (!row) throw new Problem(409, "ARTIFACT_CONTENT_CHANGED");
    // 对象 IO 在事务外；一分钟写入保护期长于二十秒调用期限，清理不会抢删正常写入。
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(20_000),
    ]);
    await abortable(signal, () => this.store.put(row.object_key, data, signal));
    const ready = await this.db.pool.query(
      "UPDATE file_artifacts SET state='ready',writing_until=now() WHERE id=$1 AND state<>'deleting' AND expires_at>now() RETURNING id",
      [row.id],
    );
    if (!ready.rowCount) throw new Problem(410, "ARTIFACT_EXPIRED");
    return {
      id: row.id,
      name,
      mediaType,
      bytes: data.length,
      sha256: digest,
      download: `/v1/files/${row.id}`,
    };
  }
  async get(actor: Principal, id: string) {
    z.uuid().parse(id);
    await this.initialize();
    const row = (
      await this.db.pool.query<FileRow>(
        "SELECT *,expires_at<=now() AS expired FROM file_artifacts WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row) throw new Problem(404, "ARTIFACT_NOT_FOUND");
    await this.tasks.get(actor, row.task_id);
    if (row.expired) throw new Problem(410, "ARTIFACT_EXPIRED");
    if (row.state !== "ready") throw new Problem(409, "ARTIFACT_NOT_READY");
    if (row.store_id !== this.store.id)
      throw new Problem(409, "ARTIFACT_STORE_CHANGED");
    const data = await this.store.get(
      row.object_key,
      AbortSignal.timeout(20_000),
    );
    if (data.length !== row.bytes || fileDigest(data) !== row.digest)
      throw new Problem(502, "ARTIFACT_INTEGRITY_FAILED");
    await this.tasks.get(actor, row.task_id);
    return { name: row.name, mediaType: row.media_type, data };
  }
  /** 运维显式调用；只删除当前存储已过期对象，失败不删元数据，可重入。 */
  async prune() {
    await this.initialize();
    let count = 0;
    for (let i = 0; i < 100; i++) {
      // 单条语句占用清理租约；对象调用不占数据库事务，失败后租约到期可再清理。
      const row = (
        await this.db.pool.query<FileRow>(
          `UPDATE file_artifacts SET state='deleting',writing_until=now()+interval '1 minute'
        WHERE id IN (SELECT id FROM file_artifacts WHERE expires_at<=now() AND writing_until<=now() AND store_id=$1 ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [this.store.id],
        )
      ).rows[0];
      if (!row) break;
      const signal = AbortSignal.timeout(20_000);
      await abortable(signal, () => this.store.remove(row.object_key, signal));
      await this.db.pool.query(
        "DELETE FROM file_artifacts WHERE id=$1 AND state='deleting'",
        [row.id],
      );
      count++;
    }
    return count;
  }
}
