/** 可信构建期 UI 扩展；按模块 ID 注册，不执行服务端返回的代码。 */
import {
  defineViews,
  type InputProps,
  type ResultProps,
} from "../../../packages/ui/index.js";
import { packageViews } from "../../../modules/package-views.js";
import { SchemaEditor } from "./schema-editor.js";
export const moduleViews = defineViews([
  { moduleId: "text", Result: TextResult },
  ...packageViews,
]);
function TextResult({ result }: ResultProps) {
  const text =
    result && typeof result === "object" && "text" in result
      ? String(result.text)
      : JSON.stringify(result, null, 2);
  return <div className="text-result">{text}</div>;
}
export function ModuleInput({
  moduleId,
  ...props
}: InputProps & { moduleId: string }) {
  const Input = moduleViews[moduleId]?.Input ?? SchemaEditor;
  return <Input {...props} />;
}
export function ModuleResult({
  moduleId,
  result,
}: ResultProps & { moduleId: string }) {
  const Result = moduleViews[moduleId]?.Result;
  return Result ? (
    <Result result={result} />
  ) : (
    <pre>{JSON.stringify(result, null, 2)}</pre>
  );
}
