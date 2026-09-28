/** 连接是可信部署配置；调用者身份只决定能否使用，不决定目标地址或秘密引用。 */
import {
  Problem,
  requireCapability,
  hasCapability,
  type Principal,
} from "../contracts/index.js";
import { abortable } from "../contracts/lifecycle.js";
export type Secret = Record<string, unknown>;
export type SecretProvider = (
  reference: string,
  signal?: AbortSignal,
) => Promise<Secret>;
export interface Connection {
  id: string;
  endpoint: string;
  credential: string;
  grants: { workspace: string; principals: string[]; capability: string }[];
  ratePerMinute?: number;
}
export class Connections {
  constructor(
    readonly definitions: readonly Connection[],
    private secrets: SecretProvider,
    private current: (workspace: string, id: string) => Promise<Principal>,
    private admit?: (key: string, limit: number) => Promise<boolean>,
    private telemetry?: import("../observability/tracing.js").Telemetry,
  ) {
    if (
      new Set(definitions.map((value) => value.id)).size !== definitions.length
    )
      throw new Error("CONNECTION_DUPLICATE");
  }
  async diagnose(
    id: string,
    signal: AbortSignal,
    validate?: (secret: Secret) => unknown,
  ) {
    const value = this.definitions.find((c) => c.id === id);
    if (!value) throw new Error("CONNECTION_NOT_FOUND");
    const secret = await abortable(signal, () =>
      this.secrets(value.credential, signal),
    );
    if (
      !secret ||
      typeof secret !== "object" ||
      Array.isArray(secret) ||
      !Object.keys(secret).length
    )
      throw new Error("CREDENTIAL_INVALID");
    validate?.(secret);
  }
  async resolve(
    id: string,
    actor: Principal,
    signal = AbortSignal.timeout(15_000),
  ) {
    const action = () => this.authorizedConnection(id, actor, signal);
    return this.telemetry
      ? this.telemetry.run(
          "connection.authorize",
          { "connection.id": id },
          action,
        )
      : action();
  }
  private async authorizedConnection(
    id: string,
    actor: Principal,
    signal = AbortSignal.timeout(15_000),
  ) {
    const principal = await this.current(actor.workspace_id, actor.id);
    const connection = this.definitions.find((item) => item.id === id);
    const grant = connection?.grants.find(
      (item) =>
        item.workspace === principal.workspace_id &&
        item.principals.includes(principal.id) &&
        hasCapability(principal, item.capability),
    );
    if (!connection) throw new Problem(403, "CONNECTION_FORBIDDEN");
    if (!grant) {
      if (
        connection.grants.some(
          (item) =>
            item.workspace === principal.workspace_id &&
            item.principals.includes(principal.id),
        )
      )
        throw new Problem(403, "FORBIDDEN");
      throw new Problem(403, "CONNECTION_FORBIDDEN");
    }
    requireCapability(principal, grant.capability);
    if (
      connection.ratePerMinute &&
      this.admit &&
      !(await this.admit(id, connection.ratePerMinute))
    )
      throw new Problem(429, "CONNECTION_RATE_LIMITED");
    const secret = await abortable(signal, () =>
      this.secrets(connection.credential, signal),
    );
    // 凭据供应可能较慢，返回外部调用参数前再次复核当前授权。
    requireCapability(
      await this.current(actor.workspace_id, actor.id),
      grant.capability,
    );
    return { endpoint: connection.endpoint, secret };
  }
}
/** 通用 API Key / OAuth 令牌映射；密码类由协议适配器独立处理。 */
export function bearer(secret: Secret): string {
  const value = secret.kind === "oauth2" ? secret.accessToken : secret.apiKey;
  if (typeof value !== "string" || !value || /[\r\n]/.test(value))
    throw new Problem(503, "CREDENTIAL_INVALID");
  if (
    secret.kind === "oauth2" &&
    (typeof secret.expiresAt !== "string" ||
      !(Date.parse(secret.expiresAt) > Date.now() + 30_000))
  )
    throw new Problem(503, "CREDENTIAL_EXPIRED");
  return value;
}
