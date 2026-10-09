/** OAuth 刷新独立于任务状态机；凭据仓储负责原子版本更新与跨进程互斥。 */
import { z } from "zod";
import type {
  Secret,
  SecretProvider,
} from "../../packages/connections/index.js";
import { ExecutionFailure } from "../../packages/contracts/failure.js";
export interface CredentialVault {
  read(reference: string): Promise<{ version: string; secret: Secret }>;
  update(
    reference: string,
    expectedVersion: string,
    secret: Secret,
  ): Promise<void>;
  exclusive<T>(reference: string, action: () => Promise<T>): Promise<T>;
}
export interface OAuthBinding {
  reference: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecretReference?: string;
}
export function refreshingSecrets(
  vault: CredentialVault,
  bindings: OAuthBinding[],
): SecretProvider {
  for (const binding of bindings)
    if (
      new URL(binding.tokenEndpoint).protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(
        new URL(binding.tokenEndpoint).hostname,
      )
    )
      throw new Error("OAUTH_HTTPS_REQUIRED");
  return async (reference, signal = AbortSignal.timeout(15000)) => {
    const binding = bindings.find((b) => b.reference === reference);
    if (!binding) return (await vault.read(reference)).secret;
    return vault.exclusive(reference, async () => {
      const { secret, version } = await vault.read(reference);
      if (
        typeof secret.expiresAt === "string" &&
        Date.parse(secret.expiresAt) > Date.now() + 60000
      )
        return secret;
      if (typeof secret.refreshToken !== "string")
        throw new ExecutionFailure(
          "authorization",
          "OAUTH_REFRESH_UNAVAILABLE",
          { notAccepted: true },
        );
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        client_id: binding.clientId,
      });
      if (binding.clientSecretReference) {
        const clientSecret = (await vault.read(binding.clientSecretReference))
          .secret.clientSecret;
        if (typeof clientSecret !== "string")
          throw new Error("OAUTH_CLIENT_SECRET_INVALID");
        body.set("client_secret", clientSecret);
      }
      const response = await fetch(binding.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new ExecutionFailure(
          response.status >= 500 ? "transient" : "authorization",
          "OAUTH_REFRESH_FAILED",
          { notAccepted: true },
        );
      const token = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().positive(),
          refresh_token: z.string().min(1).optional(),
        })
        .parse(await response.json());
      const next = {
        ...secret,
        kind: "oauth2",
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? secret.refreshToken,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      };
      await vault.update(reference, version, next);
      return next;
    });
  };
}
