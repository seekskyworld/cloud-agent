import { bounded } from "../packages/contracts/lifecycle.js";
import {
  requireCapability,
  type Json,
  type Principal,
} from "../packages/contracts/index.js";
import { fingerprint } from "../packages/contracts/fingerprint.js";
import type {
  BusinessFile,
  BusinessFileRoute,
  BusinessRoute,
} from "../packages/business/application.js";
import type { Database } from "../packages/persistence/database.js";
import type { IdentityPort } from "../packages/runtime/ports.js";

/** Application boundary for business HTTP calls; SQL auditing stays in the composition root. */
export class BusinessRequestService {
  constructor(
    private db: Database,
    private identity: IdentityPort,
  ) {}

  async invoke(
    route: BusinessRoute,
    packageId: string,
    principal: Principal,
    input: unknown,
    key?: string,
  ): Promise<Json> {
    requireCapability(principal, route.capability);
    const audit = (outcome: string) =>
      this.db.pool.query(
        "INSERT INTO business_requests(workspace_id,principal_id,package_id,route_id,command_key,outcome) VALUES($1,$2,$3,$4,$5,$6)",
        [
          principal.workspace_id,
          principal.id,
          packageId,
          route.id,
          key ?? null,
          outcome,
        ],
      );
    await audit("started");
    try {
      const output = await bounded(15_000, (signal) =>
        route.handle(input, { principal, key, signal }),
      );
      const current = await this.identity.current(
        principal.workspace_id,
        principal.id,
      );
      requireCapability(current, route.capability);
      const result = route.output.parse(output) as Json;
      await audit("succeeded");
      return result;
    } catch (error) {
      await audit(route.method === "POST" ? "unconfirmed" : "failed");
      throw error;
    }
  }

  /** 业务文件读取/上传：同一套能力复核与审计；读写大文件给 60 秒。 */
  async invokeFile(
    route: BusinessFileRoute,
    packageId: string,
    principal: Principal,
    input: unknown,
    key?: string,
    body?: Uint8Array,
  ): Promise<BusinessFile | Json> {
    requireCapability(principal, route.capability);
    const audit = (outcome: string) =>
      this.db.pool.query(
        "INSERT INTO business_requests(workspace_id,principal_id,package_id,route_id,command_key,outcome) VALUES($1,$2,$3,$4,$5,$6)",
        [
          principal.workspace_id,
          principal.id,
          packageId,
          `files/${route.id}`,
          key ?? null,
          outcome,
        ],
      );
    // 读取不写审计行（播放器会频繁按 Range 拉取）；上传记录开始与结果。
    if (route.method === "PUT") await audit("started");
    try {
      const output = await bounded(60_000, (signal) =>
        route.handle(input, { principal, key, body, signal }),
      );
      const current = await this.identity.current(
        principal.workspace_id,
        principal.id,
      );
      requireCapability(current, route.capability);
      if (route.method === "GET") {
        const file = output as BusinessFile;
        if (
          !(file?.data instanceof Uint8Array) ||
          !file.mediaType ||
          !file.name
        )
          throw new Error("BUSINESS_FILE_INVALID");
        return file;
      }
      const result = (
        route.output ? route.output.parse(output) : output
      ) as Json;
      await audit("succeeded");
      return result;
    } catch (error) {
      if (route.method === "PUT") await audit("unconfirmed");
      throw error;
    }
  }

  /** Stable request identity for diagnostics and future idempotency adapters. */
  requestFingerprint(packageId: string, route: BusinessRoute, input: unknown) {
    return fingerprint({ packageId, route: route.id, input });
  }
}
