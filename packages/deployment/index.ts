/** 部署清单只含非秘密协议身份；不可变修订与入口切换分开，回退仍需兼容制品。 */
import { Problem } from "../contracts/index.js";
import {
  DeploymentManifest as ManifestSchema,
  revisionId as computeRevisionId,
  type DeploymentManifest as DeploymentManifestType,
} from "../contracts/deployment.js";
import type { Database } from "../persistence/database.js";
export {
  ManifestSchema as DeploymentManifest,
  computeRevisionId as revisionId,
};
export function deploymentDiff(
  previous: DeploymentManifestType | null,
  next: DeploymentManifestType,
) {
  const before = new Map(
    previous?.modules.map((m) => [`${m.id}@${m.version}`, m.hash]),
  );
  const after = new Map(
    next.modules.map((m) => [`${m.id}@${m.version}`, m.hash]),
  );
  return {
    businessesChanged: [
      ...new Set([
        ...Object.keys(previous?.businesses ?? {}),
        ...Object.keys(next.businesses ?? {}),
      ]),
    ].filter((id) => previous?.businesses?.[id] !== next.businesses?.[id]),
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...after]
      .filter(([k, v]) => before.has(k) && before.get(k) !== v)
      .map(([k]) => k),
    defaultsChanged:
      JSON.stringify(previous?.defaults ?? {}) !==
      JSON.stringify(next.defaults),
  };
}
export class Deployments {
  constructor(private db: Database) {}
  async stage(manifest: DeploymentManifestType) {
    const id = computeRevisionId(manifest);
    await this.db.pool.query(
      "INSERT INTO deployment_revisions(id,manifest) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, JSON.stringify(manifest)],
    );
    return id;
  }
  async current() {
    return (
      (
        await this.db.pool.query<{
          id: string;
          manifest: DeploymentManifestType;
          generation: number;
        }>(
          "SELECT r.id,r.manifest,a.generation FROM deployment_activation a JOIN deployment_revisions r ON r.id=a.revision_id WHERE a.scope='default'",
        )
      ).rows[0] ?? null
    );
  }
  async activate(
    id: string,
    expected: string | null,
    actor: string,
    reason: string,
  ) {
    if (!actor || !reason.trim() || reason.length > 1000)
      throw new Problem(400, "DEPLOYMENT_REASON_REQUIRED");
    await this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('deployment-activation'))",
      );
      const current =
        (
          await client.query<{ revision_id: string }>(
            "SELECT revision_id FROM deployment_activation WHERE scope='default' FOR UPDATE",
          )
        ).rows[0]?.revision_id ?? null;
      if (current !== expected)
        throw new Problem(409, "DEPLOYMENT_VERSION_CONFLICT");
      if (
        !(
          await client.query(
            "SELECT id FROM deployment_revisions WHERE id=$1",
            [id],
          )
        ).rowCount
      )
        throw new Problem(404, "DEPLOYMENT_NOT_FOUND");
      await client.query(
        "INSERT INTO deployment_activation(scope,revision_id) VALUES('default',$1) ON CONFLICT(scope) DO UPDATE SET revision_id=$1,generation=deployment_activation.generation+1",
        [id],
      );
      await client.query(
        "INSERT INTO deployment_audit(previous_revision,revision_id,actor,reason) VALUES($1,$2,$3,$4)",
        [current, id, actor, reason],
      );
    });
  }
}
