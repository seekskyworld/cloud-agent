/** 可选 HTTP 认证适配器；复用可信主体映射，Cookie 不携带客户端自报角色。 */
import { Problem } from "../contracts/index.js";
import type {
  IdentityProvider,
  IdentityReference,
  IdentityRequest,
} from "./provider.js";
export class CookieIdentityProvider implements IdentityProvider {
  readonly id = "cookie";
  readonly origin: string;
  readonly secure: boolean;
  readonly name: string;
  constructor(
    private bearer: IdentityProvider,
    private resolve: (
      token: string,
      signal: AbortSignal,
    ) => Promise<IdentityReference>,
    origin: string,
    name?: string,
  ) {
    const url = new URL(origin);
    this.secure = url.protocol === "https:";
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (!this.secure &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("AUTH_ORIGIN_INVALID");
    if (bearer.id === "local")
      throw new Error("COOKIE_SHARED_IDENTITY_FORBIDDEN");
    this.origin = url.origin;
    this.name =
      name ?? (this.secure ? "__Host-agent_session" : "agent_session");
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(this.name) ||
      (!this.secure && /^__(Host|Secure)-/.test(this.name))
    )
      throw new Error("AUTH_COOKIE_INVALID");
  }
  authenticate(authorization: string | undefined, signal: AbortSignal) {
    return this.bearer.authenticate(authorization, signal);
  }
  async authenticateRequest(request: IdentityRequest, signal: AbortSignal) {
    if (request.authorization)
      return this.authenticate(request.authorization, signal);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.origin !== this.origin
    )
      throw new Problem(403, "AUTH_ORIGIN_REJECTED");
    const cookies = (request.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(this.name + "="));
    if (cookies.length !== 1) throw new Problem(401, "SESSION_REQUIRED");
    const token = cookies[0]!.slice(this.name.length + 1);
    if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token))
      throw new Problem(401, "SESSION_INVALID");
    signal.throwIfAborted();
    return this.resolve(token, signal);
  }
  /** 登录适配器验证成功后设置；有效期仍以服务端令牌/会话存储为准。 */
  cookie(token: string, seconds: number): string {
    if (
      !/^[A-Za-z0-9._~-]{16,2048}$/.test(token) ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 2592000
    )
      throw new Error("AUTH_COOKIE_INVALID");
    return this.header(token, seconds);
  }
  clearCookie() {
    return this.header("", 0);
  }
  private header(token: string, seconds: number) {
    return `${this.name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? "; Secure" : ""}`;
  }
}
