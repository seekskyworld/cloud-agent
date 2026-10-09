/** 可选令牌登录，凭据仅留在页面内存。 */
import { useState } from "react";
import { client, type Me } from "./api.js";
export function Login({
  onLogin,
}: {
  onLogin: (token: string, me: Me) => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="brand-mark">
        C<span>•</span>
      </div>
      <p className="eyebrow">CLOUD AGENT / WORKSPACE</p>
      <h1>让任务持续向前。</h1>
      <p className="muted">
        一个工作台，连接不同业务。查看进度、补充信息，确认每一次执行。
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            onLogin(token, await client(token).call("me", undefined));
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="token">访问令牌</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="输入管理员提供的访问令牌"
          required
        />
        <button disabled={busy}>{busy ? "正在连接…" : "进入工作台 →"}</button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      <small>令牌仅保留在当前页面内存中，刷新后需要重新登录。</small>
    </main>
  );
}
