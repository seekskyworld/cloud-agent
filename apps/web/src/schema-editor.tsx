/** 常见 Schema 直接生成字段；复杂约束保留 JSON 编辑，服务端始终进行最终校验。 */
import { useId, useState } from "react";
import type { Schema, InputProps } from "../../../packages/ui/index.js";
export type { Schema, InputProps } from "../../../packages/ui/index.js";
function supported(schema: Schema, depth = 0): boolean {
  if (
    depth > 4 ||
    ["oneOf", "anyOf", "allOf", "$ref"].some((key) => key in schema)
  )
    return false;
  if (schema.enum) return true;
  if (schema.type === "object")
    return (
      !!schema.properties &&
      Object.values(schema.properties).every((s) => supported(s, depth + 1))
    );
  if (schema.type === "array")
    return !!schema.items && supported(schema.items, depth + 1);
  return ["string", "number", "integer", "boolean"].includes(schema.type ?? "");
}
function initial(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object") return {};
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer")
    return schema.minimum ?? 0;
  return "";
}
function Scalar({
  schema,
  value,
  onChange,
  label,
  required,
}: {
  schema: Schema;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  required: boolean;
}) {
  const id = useId();
  if (schema.enum)
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          required={required}
          value={value === undefined ? "" : JSON.stringify(value)}
          onChange={(e) =>
            onChange(
              e.target.value === "" ? undefined : JSON.parse(e.target.value),
            )
          }
        >
          <option value="">请选择</option>
          {schema.enum.map((v, i) => (
            <option value={JSON.stringify(v)} key={i}>
              {String(v)}
            </option>
          ))}
        </select>
      </>
    );
  if (schema.type === "boolean")
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          required={required}
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            onChange(
              e.target.value === "" ? undefined : e.target.value === "true",
            )
          }
        >
          <option value="">请选择</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </>
    );
  if (schema.type === "number" || schema.type === "integer")
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="number"
          required={required}
          step={schema.type === "integer" ? 1 : "any"}
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === "number" ? value : ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      </>
    );
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={schema.maxLength && schema.maxLength <= 200 ? 2 : 3}
        required={required}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        value={typeof value === "string" ? value : ""}
        onChange={(e) =>
          onChange(!required && !e.target.value ? undefined : e.target.value)
        }
      />
    </>
  );
}
function Field({
  schema,
  value,
  onChange,
  label,
  required = false,
}: {
  schema: Schema;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  required?: boolean;
}) {
  if (schema.type === "object" && schema.properties) {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset className="schema-fields">
        <legend>{label}</legend>
        {Object.entries(schema.properties).map(([key, child]) => (
          <Field
            key={key}
            label={child.title ?? key}
            schema={child}
            required={schema.required?.includes(key)}
            value={record[key]}
            onChange={(v) => onChange({ ...record, [key]: v })}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === "array" && schema.items) {
    const items = schema.items,
      rows = Array.isArray(value) ? value : [];
    return (
      <fieldset className="schema-fields">
        <legend>{label}</legend>
        {rows.map((item, i) => (
          <div className="array-row" key={i}>
            <Field
              schema={items}
              label={`${label} ${i + 1}`}
              value={item}
              required
              onChange={(v) =>
                onChange(rows.map((old, j) => (j === i ? v : old)))
              }
            />
            <button
              type="button"
              className="text-button"
              aria-label={`移除 ${label} ${i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              移除
            </button>
          </div>
        ))}
        <button
          className="secondary"
          type="button"
          disabled={rows.length >= (schema.maxItems ?? Infinity)}
          onClick={() => onChange([...rows, initial(items)])}
        >
          添加 {label}
        </button>
      </fieldset>
    );
  }
  return (
    <div>
      <Scalar {...{ schema, value, onChange, label, required }} />
      {schema.description && (
        <small className="muted">{schema.description}</small>
      )}
    </div>
  );
}
export function SchemaEditor({ schema, value, onChange, label }: InputProps) {
  const [advanced, setAdvanced] = useState(false),
    id = useId();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const available = supported(schema) && parsed !== undefined;
  return (
    <div className="schema-editor">
      <div className="editor-mode">
        <button
          type="button"
          className="text-button"
          onClick={() => setAdvanced(!advanced)}
          disabled={!available}
        >
          {advanced ? "使用表单" : "高级 JSON"}
        </button>
      </div>
      {advanced || !available ? (
        <>
          <label htmlFor={id}>{label}（JSON）</label>
          <textarea
            id={id}
            rows={7}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </>
      ) : (
        <Field
          schema={schema}
          value={parsed}
          label={label}
          onChange={(v) => onChange(JSON.stringify(v, null, 2))}
        />
      )}
    </div>
  );
}
