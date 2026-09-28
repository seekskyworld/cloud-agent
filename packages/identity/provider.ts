/** 身份供应器只返回可信主体引用；当前能力与启停始终从平台身份库复核。 */
import { Problem } from "../contracts/index.js";
import type { IdentityService } from "./service.js";
export interface IdentityReference {
  workspace: string;
  principal: string;
}
export interface IdentityRequest {
  authorization?: string;
  cookie?: string;
  origin?: string;
  method: string;
}
export interface IdentityProvider {
  id: string;
  /** 可选的 HTTP 入口；其他调用者继续使用原 authenticate。 */
  authenticateRequest?(
    request: IdentityRequest,
    signal: AbortSignal,
  ): Promise<IdentityReference>;
  authenticate(
    authorization: string | undefined,
    signal: AbortSignal,
  ): Promise<IdentityReference>;
}
export class LocalIdentityProvider implements IdentityProvider {
  readonly id = "local";
  constructor(private reference: IdentityReference) {}
  async authenticate() {
    return { ...this.reference };
  }
}
export class TokenIdentityProvider implements IdentityProvider {
  readonly id = "token";
  constructor(private identities: IdentityService) {}
  async authenticate(authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer "))
      throw new Problem(401, "TOKEN_REQUIRED");
    const actor = await this.identities.authenticate(authorization.slice(7));
    return { workspace: actor.workspace_id, principal: actor.id };
  }
}
