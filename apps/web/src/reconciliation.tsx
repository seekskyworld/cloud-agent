import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { client, type Detail } from "./api.js";
export function ReconciliationPanel({
  detail,
  token,
  refresh,
}: {
  detail: Detail;
  token: string;
  refresh: () => Promise<void>;
}) {
  const [decision, setDecision] = useState<"succeeded" | "cancelled">(
      "cancelled",
    ),
    [reason, setReason] = useState(""),
    [receipt, setReceipt] = useState(""),
    [output, setOutput] = useState("{}"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const command = useRef({ hash: "", key: crypto.randomUUID() });
  const step = detail.steps.find(
    (s) => s.status === "unknown" && s.kind === "tool",
  );
  if (!step || detail.task.status !== "waiting_external") return null;
  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        stepId: step.id,
        expectedAttempts: step.attempts,
        decision,
        reason,
        receipt,
        ...(decision === "succeeded" ? { output: JSON.parse(output) } : {}),
      };
      const hash = JSON.stringify(body);
      if (command.current.hash !== hash)
        command.current = { hash, key: crypto.randomUUID() };
      await client(token).call("reconcile", body, {
        id: detail.task.id,
        key: command.current.key,
      });
      setError("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="panel">
      <summary>核实外部执行结果</summary>
      <p>
        先向业务系统查询回执。确认成功只补录结果；终止后续步骤不会撤销已经发生的动作。
      </p>
      <label htmlFor="resolution">核实结论</label>
      <select
        id="resolution"
        value={decision}
        onChange={(e) => setDecision(e.target.value as typeof decision)}
      >
        <option value="cancelled">终止后续步骤</option>
        <option value="succeeded">已有成功回执</option>
      </select>
      <label htmlFor="receipt">外部回执</label>
      <input
        id="receipt"
        value={receipt}
        onChange={(e) => setReceipt(e.target.value)}
      />
      <label htmlFor="resolution-reason">核实原因</label>
      <input
        id="resolution-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {decision === "succeeded" && (
        <>
          <label htmlFor="resolution-output">已确认结果（JSON）</label>
          <textarea
            id="resolution-output"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        label="提交核实"
        disabled={busy || !reason.trim() || !receipt.trim()}
        onClick={() => void submit()}
      />
    </details>
  );
}
