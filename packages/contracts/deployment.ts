import { z } from "zod";
import { fingerprint } from "./fingerprint.js";

export const DeploymentManifest = z
  .object({
    protocol: z.literal(1),
    businesses: z.record(z.string(), z.string()).optional(),
    modules: z.array(
      z.object({ id: z.string(), version: z.string(), hash: z.string() }),
    ),
    defaults: z.record(z.string(), z.string()),
  })
  .strict();

export type DeploymentManifest = z.infer<typeof DeploymentManifest>;

export function revisionId(manifest: DeploymentManifest) {
  return fingerprint(DeploymentManifest.parse(manifest));
}
