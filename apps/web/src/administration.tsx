/** 工作区权限管理只展示服务端授权的动作；版本与幂等键防止覆盖并发修改或重放旧授权。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { request } from "./api.js";
type Member = {
  id: string;
  workspace_id: string;
  role: "member" | "admin" | "superadmin";
  capabilities: string[];
  enabled: boolean;
  access_version: number;
};
type Catalog = {
  roles: { id: string; label: string; permissions: string[] }[];
  capabilities: string[];
};
type Audit = {
  id: string;
  actor_id: string;
  target_id: string;
  action: string;
  reason: string;
  created_at: string;
};
type Draft = {
  id: string;
  role: "member" | "admin";
  capabilities: string[];
  enabled: boolean;
  expectedVersion: number | null;
  reason: string;
};
const emptyDraft = (): Draft => ({
  id: "",
  role: "member",
  capabilities: [],
  enabled: true,
  expectedVersion: null,
  reason: "",
});
export function AdministrationPanel({ token }: { token: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const submission = useRef({ fingerprint: "", key: crypto.randomUUID() });
  const refresh = useCallback(async () => {
    const me = await request<{ administration: string[] }>(token, "/me");
    setCanManage(me.administration.includes("identity:manage"));
    const [catalog, members, audit] = await Promise.all([
      request<Catalog>(token, "/admin/catalog"),
      request<Member[]>(token, `/admin/principals?offset=${offset}`),
      request<Audit[]>(token, "/admin/audit"),
    ]);
    setCatalog(catalog);
    setMembers(members);
    setAudit(audit);
  }, [token, offset]);
  useEffect(() => {
    void refresh().catch((error) => {
      setCatalog(null);
      setError(String(error));
    });
  }, [refresh]);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    const fingerprint = JSON.stringify(draft);
    if (submission.current.fingerprint !== fingerprint)
      submission.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await request(
        token,
        "/admin/principals",
        draft,
        "POST",
        submission.current.key,
      );
      setDraft(null);
      setMessage("权限已保存，后续请求与任务执行会使用最新权限。");
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="administration">
      <header>
        <div>
          <p className="eyebrow">WORKSPACE ACCESS</p>
          <h1>权限管理</h1>
          <p className="muted">
            管理员查看成员与授权记录；超级管理员配置角色和业务能力。
          </p>
        </div>
        {catalog && canManage && (
          <Button
            label="新增成员"
            variant="primary"
            onClick={() => {
              setDraft(emptyDraft());
              setError("");
              setMessage("");
            }}
          />
        )}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {catalog && (
        <>
          <div className="role-summary">
            {catalog.roles.map((role) => (
              <Card key={role.id} padding={4}>
                <h2>{role.label}</h2>
                <p className="muted">
                  {role.id === "member"
                    ? "使用已获授权的业务能力"
                    : role.id === "admin"
                      ? "查看本工作区成员和审计记录"
                      : "授予或撤销管理员、管理成员能力"}
                </p>
              </Card>
            ))}
          </div>
          <Card padding={6}>
            <h2>工作区成员</h2>
            <p className="muted">
              角色不自动授予业务能力。超级管理员由服务端初始化，在这里受到保护。
            </p>
            <div className="member-list">
              {members.map((member) => (
                <div className="member-row" key={member.id}>
                  <div>
                    <strong>{member.id}</strong>
                    <small>
                      {
                        catalog.roles.find((role) => role.id === member.role)
                          ?.label
                      }{" "}
                      · {member.enabled ? "已启用" : "已停用"}
                    </small>
                    <small>
                      {member.capabilities.join("、") || "暂无业务能力"}
                    </small>
                  </div>
                  {member.role === "superadmin" ? (
                    <span className="muted">受保护</span>
                  ) : (
                    canManage && (
                      <Button
                        label={`编辑 ${member.id}`}
                        onClick={() =>
                          setDraft({
                            id: member.id,
                            role: member.role as Draft["role"],
                            capabilities: member.capabilities,
                            enabled: member.enabled,
                            expectedVersion: member.access_version,
                            reason: "",
                          })
                        }
                      >
                        编辑权限
                      </Button>
                    )
                  )}
                </div>
              ))}
            </div>
            <div className="button-row">
              <Button
                label="上一页成员"
                isDisabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              />
              <Button
                label="下一页成员"
                isDisabled={members.length < 100}
                onClick={() => setOffset(offset + 100)}
              />
            </div>
          </Card>
          {draft && canManage && (
            <Card className="access-editor" padding={6}>
              <h2>
                {draft.expectedVersion === null
                  ? "新增成员"
                  : `编辑 ${draft.id}`}
              </h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label htmlFor="member-id">成员标识</label>
                <input
                  id="member-id"
                  required
                  maxLength={120}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9@._+\-]*"
                  disabled={draft.expectedVersion !== null}
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
                <label htmlFor="member-role">管理角色</label>
                <select
                  id="member-role"
                  value={draft.role}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      role: e.target.value as Draft["role"],
                    })
                  }
                >
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
                <fieldset>
                  <legend>业务能力</legend>
                  {catalog.capabilities.map((capability) => (
                    <label className="capability-option" key={capability}>
                      <input
                        type="checkbox"
                        checked={draft.capabilities.includes(capability)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            capabilities: e.target.checked
                              ? [...draft.capabilities, capability]
                              : draft.capabilities.filter(
                                  (entry) => entry !== capability,
                                ),
                          })
                        }
                      />
                      {capability}
                    </label>
                  ))}
                </fieldset>
                <label className="capability-option">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) =>
                      setDraft({ ...draft, enabled: e.target.checked })
                    }
                  />
                  启用成员
                </label>
                <label htmlFor="access-reason">变更原因</label>
                <textarea
                  id="access-reason"
                  required
                  maxLength={1000}
                  value={draft.reason}
                  onChange={(e) =>
                    setDraft({ ...draft, reason: e.target.value })
                  }
                />
                <div className="button-row">
                  <Button
                    label="保存权限"
                    type="submit"
                    variant="primary"
                    isLoading={busy}
                    isDisabled={busy}
                  />
                  <Button
                    label="取消编辑"
                    isDisabled={busy}
                    onClick={() => setDraft(null)}
                  />
                </div>
              </form>
            </Card>
          )}
          <Card className="access-audit" padding={6}>
            <h2>最近授权记录</h2>
            <p className="muted">最近 100 条变更，包含操作者、对象与原因。</p>
            {audit.map((event) => (
              <div className="member-row" key={event.id}>
                <div>
                  <strong>
                    {event.actor_id} → {event.target_id}
                  </strong>
                  <p>{event.reason}</p>
                  <small>
                    {new Date(event.created_at).toLocaleString("zh-CN")} ·{" "}
                    {event.action}
                  </small>
                </div>
              </div>
            ))}
            {audit.length === 0 && <p className="muted">暂无授权变更。</p>}
          </Card>
        </>
      )}
    </div>
  );
}
