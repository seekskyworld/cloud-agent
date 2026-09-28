/** 轻量会话视图复用框架任务 API；页面刷新不取消后台任务。 */
import { useEffect, useState, type FormEvent } from "react";
import type { CloudAgentClient, Detail, TaskSummary } from "../api/client.js";
import type { Json } from "../contracts/index.js";
export function ConversationPanel({
  client,
  moduleId,
  title = "对话助手",
}: {
  client: CloudAgentClient;
  moduleId: string;
  title?: string;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<
    { id: string; role: string; content: Json }[]
  >([]);
  useEffect(() => {
    let active = true;
    void client
      .call("tasks", undefined)
      .then((rows) => {
        if (active) setTasks(rows.filter((t) => t.module_id === moduleId));
      })
      .catch(() => {
        if (active) setError("暂时无法读取历史请求");
      });
    return () => {
      active = false;
    };
  }, [client, moduleId]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setMessages([]);
      return;
    }
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const d = await client.call("detail", undefined, { id: selected });
        if (!active) return;
        setDetail(d);
        const history = await client.conversation(d.task.conversation_id);
        if (!active) return;
        setMessages(history);
        if (!["succeeded", "failed", "cancelled"].includes(d.task.status))
          timer = setTimeout(() => void refresh(), 1500);
      } catch {
        if (active) setError("请求暂不可读取，请刷新或重新登录");
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, selected, busy]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const task = await client.call(
        "create",
        {
          moduleId,
          input: { text },
          ...(detail ? { conversationId: detail.task.conversation_id } : {}),
        },
        { key: crypto.randomUUID() },
      );
      setSelected(task.id);
      setText("");
      setTasks(
        await client
          .call("tasks", undefined)
          .then((rows) => rows.filter((t) => t.module_id === moduleId)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法发送");
    } finally {
      setBusy(false);
    }
  }
  const waiting = detail?.waits.find(
    (w) => w.status === "pending" && w.kind === "approval",
  );
  async function decide(approved: boolean) {
    if (!detail || !waiting) return;
    setBusy(true);
    setError("");
    try {
      await client.call(
        "decide",
        { response: { approved } },
        { id: waiting.id, key: crypto.randomUUID() },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "确认未成功");
    } finally {
      setBusy(false);
    }
  }
  const content = (raw: Json) => {
    const value =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : { text: JSON.stringify(raw) };
    return typeof value.text === "string"
      ? value.text
      : typeof value.approved === "boolean"
        ? value.approved
          ? "已确认操作"
          : "已拒绝操作"
        : JSON.stringify(value, null, 2);
  };
  return (
    <section className="agent-conversation" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button
          onClick={() => {
            setSelected("");
            setDetail(null);
            setMessages([]);
            setError("");
          }}
          disabled={busy}
        >
          新建对话
        </button>
      </header>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void client
            .call("tasks", undefined)
            .then((rows) =>
              setTasks(rows.filter((t) => t.module_id === moduleId)),
            )
            .catch(() => setError("暂时无法读取历史请求"))
            .finally(() => setBusy(false));
        }}
      >
        刷新历史
      </button>
      <label>
        历史请求
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setError("");
          }}
        >
          <option value="">新对话</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {new Date(t.created_at).toLocaleString()} · {t.status}
            </option>
          ))}
        </select>
      </label>
      <div className="agent-messages" aria-live="polite">
        {messages.length ? (
          messages.map((m) => (
            <article key={m.id}>
              <b>{m.role === "user" ? "你" : "助手"}</b>
              <pre>{content(m.content)}</pre>
            </article>
          ))
        ) : (
          <p>可以直接说明你的问题或需要办理的操作。</p>
        )}
      </div>
      {detail && !["succeeded"].includes(detail.task.status) && (
        <p role="status">
          {statusMessage(detail.task.status, detail.task.error)}
        </p>
      )}
      {waiting && (
        <section>
          <pre>{waiting.reason}</pre>
          <button disabled={busy} onClick={() => void decide(true)}>
            确认执行
          </button>
          <button disabled={busy} onClick={() => void decide(false)}>
            拒绝操作
          </button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <form onSubmit={(e) => void submit(e)}>
        <label>
          消息
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={12000}
            required
            placeholder="请说明你的问题…"
          />
        </label>
        <button
          disabled={
            busy ||
            (Boolean(selected) && detail?.task.id !== selected) ||
            Boolean(
              detail &&
                ["queued", "running", "retry_scheduled"].includes(
                  detail.task.status,
                ),
            )
          }
        >
          {busy ? "正在提交…" : "发送"}
        </button>
      </form>
      {detail &&
        [
          "queued",
          "running",
          "retry_scheduled",
          "waiting_input",
          "waiting_approval",
        ].includes(detail.task.status) && (
          <button
            onClick={() => {
              setBusy(true);
              void client
                .call("cancel", {}, { id: detail.task.id })
                .catch(() => setError("暂时无法取消"))
                .finally(() => setBusy(false));
            }}
            disabled={busy}
          >
            取消当前请求
          </button>
        )}
    </section>
  );
}

function statusMessage(status: string, error: string | null) {
  if (status === "waiting_external") return "已提交，正在等待外部服务结果";
  if (status === "waiting_approval") return "请确认以下操作";
  if (status === "failed") return `请求未完成：${error ?? "请核对输入"}`;
  if (status === "cancelled") return "请求已取消";
  return "正在处理，请稍候…";
}
