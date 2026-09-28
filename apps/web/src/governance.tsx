/** 运维页面调用公开契约；服务端始终复核能力和版本。 */
import { useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { client } from "./api.js";
type Deployment = {
  id: string;
  active: string | null;
  diff: {
    added: string[];
    removed: string[];
    changed: string[];
    defaultsChanged: boolean;
  };
};
type Health = {
  unknown: string;
  queue: { incompatible: string; oldest_seconds: number };
  usage: { cost_usd: number };
  counts: { status: string; count: string }[];
};
export function GovernancePanel({
  token,
  cluster,
}: {
  token: string;
  cluster: boolean;
}) {
  const [health, setHealth] = useState<Health | null>(null),
    [deployment, setDeployment] = useState<Deployment | null>(null),
    [error, setError] = useState("");
  const refresh = async () => {
    try {
      const api = client(token);
      setHealth((await api.management("operations", undefined)) as Health);
      if (cluster)
        setDeployment(
          (await api.management("deployment", undefined)) as Deployment,
        );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, [token, cluster]);
  return (
    <section aria-label="运行治理">
      <h1>运行治理</h1>
      <p className="muted">查看当前工作区的任务积压、待核实动作与部署差异。</p>
      <Button label="刷新运行状态" onClick={() => void refresh()} />
      {error && <p role="alert">{error}</p>}
      {health && (
        <Card className="panel" padding={6}>
          <h2>工作区运行状态</h2>
          <p>待核实动作：{health.unknown}</p>
          <p>等待兼容版本的任务：{health.queue.incompatible}</p>
          <p>最长排队：{Math.round(health.queue.oldest_seconds)} 秒</p>
          <p>累计执行费用：${Number(health.usage.cost_usd).toFixed(4)}</p>
          <p className="muted">
            未知动作请在对应任务详情中提交外部回执核实。版本不兼容需恢复匹配的
            Worker，不能直接重发任务。
          </p>
        </Card>
      )}
      {deployment && (
        <Card className="panel" padding={6}>
          <h2>部署差异</h2>
          <p>
            当前修订：<code>{deployment.id.slice(0, 16)}</code>
          </p>
          <p>
            已启用修订：{deployment.active?.slice(0, 16) ?? "未启用修订管理"}
          </p>
          <p>新增模块：{deployment.diff.added.join("、") || "无"}</p>
          <p>移除模块：{deployment.diff.removed.join("、") || "无"}</p>
          <p>依赖变化：{deployment.diff.changed.join("、") || "无"}</p>
          <p>默认版本变化：{deployment.diff.defaultsChanged ? "有" : "无"}</p>
          <p className="muted">
            部署切换由运维命令执行，保留旧版本以排空历史任务。
          </p>
        </Card>
      )}
    </section>
  );
}
