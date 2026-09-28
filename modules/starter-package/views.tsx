import type { ModuleView, ResultProps } from "../../packages/ui/index.js";
function ReportResult({ result }: ResultProps) {
  const name =
    result && typeof result === "object" && "name" in result
      ? String(result.name)
      : "report.txt";
  return (
    <div className="text-result">
      <strong>报告已生成</strong>
      <p>{name} 可从下方文件列表下载。</p>
    </div>
  );
}
export const starterViews: ModuleView[] = [
  { moduleId: "starter-report", Result: ReportResult },
];
