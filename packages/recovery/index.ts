/** 联合备份在维护窗口保存数据库、对象摘要和部署修订；密钥本体由独立系统保管。 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../persistence/database.js";
import type { ArtifactFiles } from "../artifacts/index.js";
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const BundleManifest = z
  .object({
    version: z.literal(1),
    createdAt: z.string(),
    databaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revisions: z.array(z.string()),
    secretReferences: z.array(z.string()).default([]),
    files: z.array(
      z.object({
        store: z.string(),
        identity: z.string(),
        key: z.string().regex(/^[a-f0-9]{64}$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  })
  .strict();
export async function exportBundle(
  db: Database,
  stores: Map<string, ArtifactFiles>,
  directory: string,
  dump: (path: string) => Promise<void>,
  secretReferences: string[] = [],
) {
  if (
    !(await db.pool.query("SELECT 1 FROM platform_maintenance WHERE enabled"))
      .rowCount
  )
    throw new Error("MAINTENANCE_REQUIRED");
  if (
    (
      await db.pool.query(
        "SELECT id FROM tasks WHERE status='running' AND lease_until>now() LIMIT 1",
      )
    ).rowCount ||
    (
      await db.pool.query(
        "SELECT id FROM file_artifacts WHERE state NOT IN ('ready','deleted') LIMIT 1",
      )
    ).rowCount
  )
    throw new Error("EXECUTION_NOT_QUIESCENT");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "objects"), { mode: 0o700 });
  const rows = (
    await db.pool.query<{
      store_id: string;
      object_key: string;
      digest: string;
    }>(
      "SELECT store_id,object_key,digest FROM file_artifacts WHERE state='ready' ORDER BY store_id,object_key",
    )
  ).rows;
  const files: z.infer<typeof BundleManifest>["files"] = [];
  for (const row of rows) {
    const store = stores.get(row.store_id)?.store;
    if (!store) throw new Error("BACKUP_STORE_UNAVAILABLE");
    const data = await store.get(row.object_key, AbortSignal.timeout(20_000));
    if (digest(data) !== row.digest) throw new Error("BACKUP_OBJECT_CORRUPTED");
    // 同摘要对象只写一次；数据目录是本命令独占创建的。
    try {
      await writeFile(join(directory, "objects", row.digest), data, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      )
        throw error;
    }
    files.push({
      store: store.id,
      identity: store.identity,
      key: row.object_key,
      digest: row.digest,
    });
  }
  const path = join(directory, "database.sql");
  await dump(path);
  const manifest = {
    version: 1 as const,
    secretReferences: [...new Set(secretReferences)].sort(),
    createdAt: new Date().toISOString(),
    databaseDigest: digest(await readFile(path)),
    revisions: (
      await db.pool.query<{ id: string }>(
        "SELECT id FROM deployment_revisions ORDER BY id",
      )
    ).rows.map((r) => r.id),
    files,
  };
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
export async function verifyBundle(directory: string) {
  const manifest = BundleManifest.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (
    digest(await readFile(join(directory, "database.sql"))) !==
    manifest.databaseDigest
  )
    throw new Error("BACKUP_DATABASE_CORRUPTED");
  for (const file of manifest.files)
    if (
      digest(await readFile(join(directory, "objects", file.digest))) !==
      file.digest
    )
      throw new Error("BACKUP_OBJECT_CORRUPTED");
  return manifest;
}
export async function restoreObjects(
  db: Database,
  stores: Map<string, ArtifactFiles>,
  directory: string,
) {
  const manifest = await verifyBundle(directory);
  if (
    !(await db.pool.query("SELECT 1 FROM platform_maintenance WHERE enabled"))
      .rowCount
  )
    throw new Error("MAINTENANCE_REQUIRED");
  const rows = (
    await db.pool.query<{
      store_id: string;
      object_key: string;
      digest: string;
    }>(
      "SELECT store_id,object_key,digest FROM file_artifacts WHERE state='ready'",
    )
  ).rows;
  if (
    rows.length !== manifest.files.length ||
    rows.some(
      (row) =>
        !manifest.files.some(
          (file) =>
            file.store === row.store_id &&
            file.key === row.object_key &&
            file.digest === row.digest,
        ),
    )
  )
    throw new Error("BACKUP_DATABASE_OBJECT_MISMATCH");
  const revisions = (
    await db.pool.query<{ id: string }>(
      "SELECT id FROM deployment_revisions ORDER BY id",
    )
  ).rows.map((r) => r.id);
  if (JSON.stringify(revisions) !== JSON.stringify(manifest.revisions))
    throw new Error("BACKUP_REVISION_MISMATCH");
  for (const file of manifest.files) {
    const store = stores.get(file.store)?.store;
    if (!store || store.identity !== file.identity)
      throw new Error("BACKUP_STORE_IDENTITY_CHANGED");
    await store.put(
      file.key,
      await readFile(join(directory, "objects", file.digest)),
      AbortSignal.timeout(20_000),
    );
    if (
      digest(await store.get(file.key, AbortSignal.timeout(20_000))) !==
      file.digest
    )
      throw new Error("RESTORE_VERIFY_FAILED");
  }
  return { restored: manifest.files.length, createdAt: manifest.createdAt };
}

/** 只收集逻辑 credential 引用名，绝不序列化配置中的密钥值或凭据供应器。 */
export function collectSecretReferences(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const names = Object.entries(value).flatMap(([key, item]) =>
    key === "credential" && typeof item === "string"
      ? [item]
      : collectSecretReferences(item),
  );
  return [...new Set(names)].sort();
}
