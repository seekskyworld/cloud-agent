import { BusinessPage, useBusinessPages } from "./business-pages.js";
import { client } from "./api.js";
/** 工作台协调选择、轮询和幂等提交，各业务视图由独立组件承载。 */
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
} from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  request,
  statusLabel,
  type Agent,
  type Detail,
  type TaskSummary,
  type Me,
  type Schedule,
} from "./api.js";
import { TaskView } from "./task-view.js";
import { TaskComposer } from "./task-composer.js";
const GovernancePanel = lazy(async () => ({
  default: (await import("./governance.js")).GovernancePanel,
}));
const AdministrationPanel = lazy(async () => ({
  default: (await import("./administration.js")).AdministrationPanel,
}));
function GovernanceNavigation({
  allowed,
  view,
  setView,
}: {
  allowed: boolean;
  view: string;
  setView: (view: string) => void;
}) {
  return allowed ? (
    <button
      className={view === "governance" ? "nav-active" : "nav-item"}
      onClick={() => setView("governance")}
    >
      运行治理
    </button>
  ) : null;
}
export function Workspace({
  token,
  me,
  logout,
}: {
  token: string;
  me: Me;
  logout: () => void;
}) {
  const [view, setView] = useState<string>("tasks");
  const businessPages = useBusinessPages(token);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [interval, setIntervalValue] = useState(3600);
  const [conversationId, setConversationId] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const submission = useRef({ fingerprint: "", key: crypto.randomUUID() });
  const refresh = useCallback(async () => {
    const list = await client(token).call("tasks", undefined);
    setTasks(list);
    if (selected) {
      const current = await client(token).call("detail", undefined, {
        id: selected,
      });
      if (selectedRef.current === selected) setDetail(current);
    }
    if (me.principal.capabilities.includes("schedule:write"))
      setSchedules(await request<Schedule[]>(token, "/schedules"));
  }, [token, selected, me.principal.capabilities]);
  useEffect(() => {
    void client(token)
      .call("agents", undefined)
      .then((rows) => {
        setAgents(rows);
        const first = rows[0];
        if (first) {
          setAgentId(first.id);
          setInput(JSON.stringify(first.example, null, 2));
        }
      })
      .catch((error) => setError(String(error)));
  }, [token]);
  useEffect(() => {
    let active = true;
    const update = () =>
      void refresh().catch((error) => {
        if (active) {
          setDetail(null);
          setError(String(error));
        }
      });
    update();
    const timer = window.setInterval(update, 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  const submit = async (scheduled = false) => {
    setBusy(true);
    setError("");
    try {
      const payload = { moduleId: agentId, input: JSON.parse(input) };
      if (scheduled) {
        await request(token, "/schedules", {
          ...payload,
          intervalSeconds: interval,
        });
      } else {
        const fingerprint = JSON.stringify({ ...payload, conversationId });
        if (submission.current.fingerprint !== fingerprint)
          submission.current = { fingerprint, key: crypto.randomUUID() };
        const created = await client(token).call(
          "create",
          {
            ...payload,
            ...(conversationId ? { conversationId } : {}),
          },
          { key: submission.current.key },
        );
        submission.current = { fingerprint: "", key: crypto.randomUUID() };
        setSelected(created.id);
      }
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace">
      <aside>
        <div className="logo">
          <span className="brand-mark">
            C<span>•</span>
          </span>
          <strong>cloud agent</strong>
        </div>
        <p className="eyebrow">WORKSPACE</p>
        <button
          className={view === "tasks" ? "nav-active" : "nav-item"}
          onClick={() => setView("tasks")}
        >
          ◉ 任务工作台
        </button>
        {me.administration.includes("identity:read") && (
          <button
            className={view === "administration" ? "nav-active" : "nav-item"}
            onClick={() => setView("administration")}
          >
            权限管理
          </button>
        )}
        <GovernanceNavigation
          allowed={me.principal.capabilities.includes("operations:read")}
          view={view}
          setView={setView}
        />
        {businessPages.map((page) => (
          <button
            key={page.id}
            className={view === page.id ? "nav-active" : "nav-item"}
            onClick={() => setView(page.id)}
          >
            {page.title}
          </button>
        ))}
        <div className="sidebar-bottom">
          <span>{me.principal.workspace_id}</span>
          <small>{me.principal.id}</small>
          {me.authMode === "token" && (
            <button className="secondary" onClick={logout}>
              退出登录
            </button>
          )}
        </div>
      </aside>
      <main>
        {(me.principal.capabilities.includes("operations:read") ||
          businessPages.length > 0 ||
          me.administration.includes("identity:read")) && (
          <nav className="mobile-pages">
            <button onClick={() => setView("tasks")}>任务工作台</button>
            {me.administration.includes("identity:read") && (
              <button onClick={() => setView("administration")}>
                权限管理
              </button>
            )}
            <GovernanceNavigation
              allowed={me.principal.capabilities.includes("operations:read")}
              view={view}
              setView={setView}
            />
            {businessPages.map((page) => (
              <button key={page.id} onClick={() => setView(page.id)}>
                {page.title}
              </button>
            ))}
          </nav>
        )}
        {businessPages.some((p) => p.id === view) ? (
          <BusinessPage id={view} token={token} />
        ) : view === "governance" ? (
          <Suspense fallback={<p>正在读取运行状态…</p>}>
            <GovernancePanel
              token={token}
              cluster={me.principal.capabilities.includes("operations:cluster")}
            />
          </Suspense>
        ) : view === "administration" ? (
          <Suspense fallback={<p>正在读取权限管理…</p>}>
            <AdministrationPanel token={token} />
          </Suspense>
        ) : (
          <>
            <header>
              <div>
                <p className="eyebrow">YOUR EXECUTION SPACE</p>
                <Heading level={1}>
                  任务工作台<span className="header-dot">.</span>
                </Heading>
                <p className="muted">创建任务，让每一步都有记录。</p>
              </div>
              {me.authMode === "token" && (
                <button className="mobile-logout secondary" onClick={logout}>
                  退出登录
                </button>
              )}
              <span className="mode">
                通用任务工作台 ·{" "}
                {me.engine.startsWith("demo") ? "未连接模型" : "模型已配置"}
              </span>
            </header>
            {error && (
              <div className="error banner" role="alert">
                {error}
                <button className="text-button" onClick={() => setError("")}>
                  关闭
                </button>
              </div>
            )}
            <div className="columns">
              <div>
                <TaskComposer
                  {...{
                    agents,
                    agentId,
                    setAgentId,
                    input,
                    setInput,
                    conversationId,
                    setConversationId,
                    detail,
                    busy,
                    submit,
                  }}
                />
                <section className="panel">
                  <div className="section-title">
                    <h2>最近任务</h2>
                    <span className="muted">{tasks.length} 项</span>
                  </div>
                  <div className="task-list">
                    {tasks.length ? (
                      tasks.map((task) => (
                        <button
                          className={`task-row ${selected === task.id ? "selected" : ""}`}
                          key={task.id}
                          disabled={task.available === false}
                          title={
                            task.available === false
                              ? "模块未安装，恢复兼容版本后可查看详情"
                              : undefined
                          }
                          onClick={() => {
                            setSelected(task.id);
                            setDetail(null);
                          }}
                        >
                          <div>
                            <strong>
                              {agents.find((a) => a.id === task.module_id)
                                ?.title ?? task.module_id}
                            </strong>
                            <small>
                              {task.available === false && "模块未安装 · "}
                              {task.compatibility ===
                                "requires_compatible_worker" &&
                                "等待兼容版本 · "}
                              {new Date(task.created_at).toLocaleString(
                                "zh-CN",
                              )}
                            </small>
                          </div>
                          <Badge
                            className={`badge ${task.status}`}
                            variant={
                              task.status === "succeeded"
                                ? "success"
                                : task.status === "failed"
                                  ? "error"
                                  : "neutral"
                            }
                            label={statusLabel[task.status]}
                          />
                        </button>
                      ))
                    ) : (
                      <EmptyState
                        title="从第一个任务开始"
                        description="任务进度会自动出现在这里。"
                        icon={<StatusDot variant="info" label="等待任务" />}
                        isCompact
                      />
                    )}
                  </div>
                </section>
                {me.principal.capabilities.includes("schedule:write") && (
                  <section className="panel">
                    <h2>定时任务</h2>
                    <p className="muted">
                      使用上方助手与任务内容，按周期创建新任务。
                    </p>
                    <label htmlFor="interval">执行间隔（秒，至少 60）</label>
                    <input
                      id="interval"
                      type="number"
                      min={60}
                      value={interval}
                      onChange={(e) => setIntervalValue(Number(e.target.value))}
                    />
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void submit(true)}
                    >
                      创建定时任务
                    </button>
                    {schedules
                      .filter((s) => s.enabled)
                      .map((s) => (
                        <div className="schedule" key={s.id}>
                          <span>
                            {s.module_id} · 每 {s.interval_seconds} 秒
                          </span>
                          <button
                            className="text-button"
                            onClick={async () => {
                              try {
                                await request(
                                  token,
                                  `/schedules/${s.id}`,
                                  undefined,
                                  "DELETE",
                                );
                                await refresh();
                              } catch (error) {
                                setError(String(error));
                              }
                            }}
                          >
                            停用
                          </button>
                        </div>
                      ))}
                  </section>
                )}
              </div>
              {detail ? (
                <TaskView
                  key={detail.task.id}
                  detail={detail}
                  canReconcile={me.principal.capabilities.includes(
                    "task:reconcile",
                  )}
                  token={token}
                  refresh={refresh}
                  onError={setError}
                />
              ) : (
                <Card className="panel detail empty large" padding={8}>
                  <Stack gap={3} align="center">
                    <StatusDot
                      variant="info"
                      label="尚未选择任务"
                      isPulsing={Boolean(selected)}
                    />
                    <Heading level={2}>
                      {selected ? "正在读取任务" : "每一个步骤，都清晰可见"}
                    </Heading>
                    <p className="muted">
                      选择左侧任务，查看执行进度、处理等待事项和下载产物。
                    </p>
                  </Stack>
                </Card>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
