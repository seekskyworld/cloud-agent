/** 通用工作台启动入口；模块表单、详情和权限页分别维护。 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { client, ApiError, type Me } from "./api.js";
import { Workspace } from "./workspace.js";
import { Login } from "./login.js";
import "./style.css";
import "@astryxdesign/theme-neutral/theme.css";
function App() {
  const [session, setSession] = useState<{ token: string; me: Me } | null>(
    null,
  );
  const [state, setState] = useState<"loading" | "login" | "error">("loading");
  const connect = useCallback(async () => {
    setState("loading");
    try {
      setSession({ token: "", me: await client("").call("me", undefined) });
    } catch (error) {
      setState(
        error instanceof ApiError && error.status === 401 ? "login" : "error",
      );
    }
  }, []);
  useEffect(() => {
    void connect();
  }, [connect]);
  if (session)
    return (
      <Workspace
        {...session}
        logout={() => {
          setSession(null);
          setState("login");
        }}
      />
    );
  if (state === "login")
    return <Login onLogin={(token, me) => setSession({ token, me })} />;
  return (
    <main className="login">
      <h1>{state === "loading" ? "正在打开工作台…" : "暂时无法连接工作台"}</h1>
      {state === "error" && (
        <button onClick={() => void connect()}>重新连接</button>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <Theme theme={neutralTheme} mode="light">
    <App />
  </Theme>,
);
