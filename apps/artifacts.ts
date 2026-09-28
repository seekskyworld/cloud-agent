/** 存储后端静态注册；密钥仅在 SDK 发请求前读取，诊断和元数据不包含凭据。 */
import { z } from "zod";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ExtensionRegistry,
  defineExtension,
} from "../packages/extensions/registry.js";
import type { ArtifactStore } from "../packages/artifacts/index.js";
import type { SecretProvider } from "../packages/connections/index.js";
import { LocalArtifacts } from "../adapters/artifacts/local.js";
import { S3Artifacts } from "../adapters/artifacts/s3.js";
const Local = z
  .object({
    provider: z.literal("local"),
    id: z.string().min(1),
    directory: z.string().min(1),
  })
  .strict();
const S3 = z
  .object({
    provider: z.literal("s3"),
    id: z.string().min(1),
    endpoint: z.url().optional(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    credential: z.string().min(1),
  })
  .strict();
export const artifactProviders = new ExtensionRegistry<
  ArtifactStore,
  SecretProvider
>([
  defineExtension<ArtifactStore, SecretProvider, typeof Local>({
    id: "local",
    capabilities: ["read", "write", "delete"],
    schema: Local,
    diagnose: async () => {},
    create: (c) => new LocalArtifacts(c.directory, c.id),
  }),
  defineExtension<ArtifactStore, SecretProvider, typeof S3>({
    id: "s3",
    capabilities: ["read", "write", "delete"],
    schema: S3,
    references: (c) => [{ kind: "secret", id: c.credential }],
    async diagnose(c, secrets, signal) {
      const secret = await secrets(c.credential, signal);
      if (
        typeof secret.accessKeyId !== "string" ||
        !secret.accessKeyId ||
        typeof secret.secretAccessKey !== "string" ||
        !secret.secretAccessKey
      )
        throw new Error("CREDENTIAL_INVALID");
    },
    create: (c, secrets) =>
      new S3Artifacts(
        new S3Client({
          endpoint: c.endpoint,
          region: c.region,
          forcePathStyle: true,
          credentials: async () => {
            try {
              const secret = await secrets(c.credential);
              return z
                .object({
                  accessKeyId: z.string().min(1),
                  secretAccessKey: z.string().min(1),
                  sessionToken: z.string().optional(),
                })
                .parse(secret);
            } catch {
              throw new Error("CREDENTIAL_UNAVAILABLE");
            }
          },
        }),
        c.bucket,
        c.id,
        JSON.stringify(["s3", c.endpoint ?? null, c.region, c.bucket]),
      ),
  }),
]);
export function loadArtifacts(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    const value = z
      .object({ provider: z.string() })
      .passthrough()
      .parse(JSON.parse(raw));
    artifactProviders.parse(value.provider, value);
    return value;
  } catch {
    throw new Error("ARTIFACT_CONFIG_INVALID");
  }
}
