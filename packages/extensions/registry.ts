/** 静态扩展注册：每个实现拥有自己的配置 Schema，宿主只依赖统一产物和上下文。 */
import { z } from "zod";
import { abortable } from "../contracts/lifecycle.js";
export interface ExtensionReference {
  kind: "connection" | "secret";
  id: string;
}
export interface Diagnostic {
  status: "passed" | "failed" | "unchecked";
  ok: boolean;
  code: string;
}
export interface Extension<T, C> {
  id: string;
  capabilities: readonly string[];
  schema: z.ZodType;
  identity?: (config: unknown) => {
    key: string;
    exclusiveCredential?: boolean;
  };
  references?: (config: unknown) => ExtensionReference[];
  diagnose?: (
    config: unknown,
    context: C,
    signal: AbortSignal,
  ) => Promise<void>;
  create(config: unknown, context: C): T | Promise<T>;
}
export function defineExtension<T, C, S extends z.ZodType>(definition: {
  id: string;
  capabilities: readonly string[];
  schema: S;
  identity?: (config: z.output<S>) => {
    key: string;
    exclusiveCredential?: boolean;
  };
  references?: (config: z.output<S>) => ExtensionReference[];
  diagnose?: (
    config: z.output<S>,
    context: C,
    signal: AbortSignal,
  ) => Promise<void>;
  create(config: z.output<S>, context: C): T | Promise<T>;
}): Extension<T, C> {
  return {
    ...definition,
    identity: definition.identity
      ? (config) => definition.identity!(definition.schema.parse(config))
      : undefined,
    references: definition.references
      ? (config) => definition.references!(definition.schema.parse(config))
      : undefined,
    diagnose: definition.diagnose
      ? (config, context, signal) =>
          definition.diagnose!(definition.schema.parse(config), context, signal)
      : undefined,
    create: (config, context) =>
      definition.create(definition.schema.parse(config), context),
  };
}
export class ExtensionRegistry<T, C> {
  private entries = new Map<string, Extension<T, C>>();
  constructor(entries: Extension<T, C>[] = []) {
    for (const entry of entries) this.register(entry);
  }
  register(entry: Extension<T, C>) {
    if (this.entries.has(entry.id)) throw new Error("EXTENSION_DUPLICATE");
    this.entries.set(entry.id, entry);
    return this;
  }
  private get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("EXTENSION_NOT_REGISTERED");
    return entry;
  }
  parse(id: string, config: unknown): unknown {
    const parsed = this.get(id).schema.safeParse(config);
    if (!parsed.success) throw new Error("EXTENSION_CONFIG_INVALID");
    return parsed.data;
  }
  create(id: string, config: unknown, context: C) {
    return this.get(id).create(this.parse(id, config), context);
  }
  identity(id: string, config: unknown) {
    return this.get(id).identity?.(this.parse(id, config));
  }
  references(id: string, config: unknown) {
    return this.get(id).references?.(this.parse(id, config)) ?? [];
  }
  async diagnose(id: string, config: unknown, context: C): Promise<Diagnostic> {
    try {
      const value = this.parse(id, config),
        entry = this.get(id);
      if (!entry.diagnose)
        return {
          status: "unchecked",
          ok: false,
          code: "DIAGNOSTIC_NOT_IMPLEMENTED",
        };
      const signal = AbortSignal.timeout(5000);
      await abortable(signal, () => entry.diagnose!(value, context, signal));
      return { status: "passed", ok: true, code: "OK" };
    } catch {
      return {
        status: "failed",
        ok: false,
        code: "CONFIG_OR_CREDENTIAL_UNAVAILABLE",
      };
    }
  }
  describe() {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      capabilities: entry.capabilities,
      diagnostic: Boolean(entry.diagnose),
      schema: z.toJSONSchema(entry.schema),
    }));
  }
}
/** 宿主拥有自己创建的资源；逆序关闭，单项失败不阻止其余资源释放。 */
export class Resources {
  private disposers: (() => Promise<void>)[] = [];
  private closed?: Promise<void>;
  add(close?: () => Promise<void>) {
    if (close) this.disposers.push(close);
  }
  close() {
    return (this.closed ??= (async () => {
      const failures: unknown[] = [];
      for (const close of this.disposers.reverse()) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new Error("EXTENSION_CLOSE_FAILED");
    })());
  }
}
