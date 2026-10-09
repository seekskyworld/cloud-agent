/** 企业 OIDC 令牌经签名/发行方/受众/期限验证后，只映射到预先配置的平台主体。 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import type { IdentityProvider } from "../../packages/identity/provider.js";
export const OidcConfig = z
  .object({
    issuer: z.url(),
    audience: z.string().min(1),
    jwksUrl: z.url(),
    subjects: z.array(
      z
        .object({
          subject: z.string().min(1),
          workspace: z.string().min(1),
          principal: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export class OidcIdentityProvider implements IdentityProvider {
  readonly id = "oidc";
  private key: JWTVerifyGetKey;
  constructor(
    private config: z.infer<typeof OidcConfig>,
    key?: JWTVerifyGetKey,
  ) {
    OidcConfig.parse(config);
    const url = new URL(config.jwksUrl);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("OIDC_HTTPS_REQUIRED");
    if (
      new Set(config.subjects.map((s) => s.subject)).size !==
      config.subjects.length
    )
      throw new Error("OIDC_SUBJECT_DUPLICATE");
    this.key =
      key ??
      createRemoteJWKSet(url, {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
      });
  }
  async authenticate(authorization: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!authorization?.startsWith("Bearer "))
      throw new Problem(401, "TOKEN_REQUIRED");
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.key, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      });
      signal.throwIfAborted();
      const identity = this.config.subjects.find(
        (s) => s.subject === payload.sub,
      );
      if (!identity) throw new Error("unmapped");
      return { workspace: identity.workspace, principal: identity.principal };
    } catch {
      throw new Problem(401, "OIDC_TOKEN_INVALID");
    }
  }
}
