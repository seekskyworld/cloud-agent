import { ReconciliationPanel } from "./reconciliation.js";
/** 任务详情和交互等待只调用任务 API，不执行模块业务。 */
import { useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { client, request, statusLabel, type Detail } from "./api.js";
import { SchemaEditor } from "./schema-editor.js";
import { moduleViews, ModuleResult } from "./module-views.js";
export function TaskView({
  canReconcile,
  detail,
  token,
  refresh,
  onError,
}: {
  detail: Detail;
  canReconcile?: boolean;
  token: string;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [response, setResponse] = useState("{}");
  const [busy, setBusy] = useState(false);
  const action = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      await request(token, path, body);
      await refresh();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const task = detail.task;
  const Actions = moduleViews[task.module_id]?.Actions;
  return (
    <Card className="panel detail" padding={6}>
      <div className="section-title">
        <div>
          <p className="eyebrow">TASK DETAIL</p>
          <h2>任务详情</h2>
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
      </div>
      <p className="task-id">{task.id}</p>
      <div className="metrics">
        <div>
          <strong>{task.tool_calls}</strong>
          <span>工具执行</span>
        </div>
        <div>
          <strong>{task.model_calls}</strong>
          <span>模型调用</span>
        </div>
        <div>
          <strong>${Number(task.cost_usd).toFixed(4)}</strong>
          <span>估算费用</span>
        </div>
      </div>
      {task.error && (
        <p className="error" role="alert">
          {task.error}
        </p>
      )}
      {detail.waits
        .filter((wait) => wait.status === "pending")
        .map((wait) => (
          <div className="wait-box" key={wait.id}>
            <h3>
              {wait.kind === "approval" ? "需要你的确认" : "任务正在等待"}
            </h3>
            <p>{wait.reason}</p>
            {wait.kind === "approval" ? (
              <div className="button-row">
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(`/waits/${wait.id}/decisions`, {
                      response: { approved: true },
                    })
                  }
                >
                  确认执行
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(`/waits/${wait.id}/decisions`, {
                      response: { approved: false },
                    })
                  }
                >
                  拒绝
                </button>
              </div>
            ) : wait.kind === "external" ? (
              <p className="muted">等待外部系统回调。</p>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    void action(`/tasks/${task.id}/inputs`, {
                      waitId: wait.id,
                      response: JSON.parse(response),
                    });
                  } catch (error) {
                    onError(String(error));
                  }
                }}
              >
                <SchemaEditor
                  key={wait.id}
                  schema={wait.schema}
                  value={response}
                  onChange={setResponse}
                  label="补充信息"
                />
                <button disabled={busy}>提交补充</button>
              </form>
            )}
          </div>
        ))}
      <div className="button-row">
        {!["succeeded", "failed", "cancelled"].includes(task.status) && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => void action(`/tasks/${task.id}/cancel`, {})}
          >
            取消任务
          </button>
        )}
        {["failed", "waiting_external"].includes(task.status) && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => void action(`/tasks/${task.id}/retry`, {})}
          >
            重试 / 查询执行结果
          </button>
        )}
      </div>
      {task.status === "cancelled" && (
        <p className="muted">
          已停止后续步骤；已发生的业务动作仍需查看执行记录。
        </p>
      )}
      {(detail.modelRequests ?? []).some((r) =>
        ["unknown", "cancelling"].includes(r.state),
      ) && (
        <p className="muted">
          模型请求的远端状态尚未确认，可能仍在计算或计费。系统会核对状态并控制重试；任务取消不代表供应商已停止。
        </p>
      )}
      {canReconcile && (
        <ReconciliationPanel detail={detail} token={token} refresh={refresh} />
      )}
      <h3>执行步骤</h3>
      {detail.steps.length ? (
        <ol className="steps">
          {detail.steps.map((step) => (
            <li key={step.id}>
              <span className={`dot ${step.status}`} />
              <div>
                <strong>{step.key}</strong>
                <small>
                  {step.kind} · {step.status} · {step.attempts} 次尝试
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">任务尚未开始执行。</p>
      )}
      {detail.invocations.some((i) => i.status === "unknown") && (
        <p className="error">
          存在结果未确认的业务动作，请先查询结果，避免重复提交新任务。
        </p>
      )}
      {task.result !== null && (
        <>
          <h3>任务结果</h3>
          <ModuleResult moduleId={task.module_id} result={task.result} />
        </>
      )}
      {Actions && (
        <Actions detail={detail} client={client(token)} refresh={refresh} />
      )}
      {detail.files.map((file) => (
        <button
          className="artifact"
          key={file.id}
          onClick={async () => {
            try {
              const blob = await client(token).downloadFile(file.id);
              const url = URL.createObjectURL(blob),
                link = document.createElement("a");
              link.href = url;
              link.download = file.name;
              link.click();
              URL.revokeObjectURL(url);
            } catch (error) {
              onError(String(error));
            }
          }}
        >
          ↓ 下载文件 · {file.name} ({file.bytes} bytes)
        </button>
      ))}
      {detail.artifacts.map((artifact) => (
        <button
          className="artifact"
          key={artifact.id}
          onClick={async () => {
            try {
              const result = await request(token, `/artifacts/${artifact.id}`);
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(result, null, 2)], {
                  type: "application/json",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `${artifact.id}.json`;
              link.click();
              URL.revokeObjectURL(url);
            } catch (error) {
              onError(String(error));
            }
          }}
        >
          ↓ 下载产物 · {artifact.title}
        </button>
      ))}
      <details>
        <summary>查看请求内容</summary>
        <pre>{JSON.stringify(task.input, null, 2)}</pre>
      </details>
    </Card>
  );
}
