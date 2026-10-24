import {
  ProcessExecutionHost,
  isolateModule,
  nextAction,
  type ExecutionHost,
} from "../execution-host/index.js";
import type { Data, Step, Tool } from "../contracts/index.js";
/** 注册表冻结版本与配置摘要；装配层负责选择具体模块。 */
import { defaultBudget, Problem, type Module } from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { z } from "zod";
function validateReconciliationPolling(tool: Tool) {
  if (
    tool.deferred &&
    (tool.effect !== "reconcilable_write" ||
      !tool.reconcile ||
      !Number.isInteger(tool.deferred.maxConcurrent) ||
      tool.deferred.maxConcurrent < 1 ||
      tool.deferred.maxConcurrent > 64)
  )
    throw new Error(`Invalid deferred tool: ${tool.name}`);
  if (tool.continueOnUnknown && tool.effect !== "reconcilable_write")
    throw new Error(`Invalid unknown continuation: ${tool.name}`);
  if (
    tool.reconciliationPolling &&
    (tool.effect !== "reconcilable_write" ||
      !tool.reconcile ||
      !Number.isInteger(tool.reconciliationPolling.intervalMs) ||
      tool.reconciliationPolling.intervalMs < 1000 ||
      tool.reconciliationPolling.intervalMs > 3600000 ||
      !Number.isInteger(tool.reconciliationPolling.maxAttempts) ||
      tool.reconciliationPolling.maxAttempts < 1 ||
      tool.reconciliationPolling.maxAttempts > 100)
  )
    throw new Error(`Invalid reconciliation polling: ${tool.name}`);
}
export class Registry {
  constructor(
    private runtimeProfile = "default",
    private modelProfiles: Record<string, string> = {},
    private contextProfiles: Record<string, string> = {},
    readonly executionHost: ExecutionHost = new ProcessExecutionHost(),
  ) {}
  private modules = new Map<string, Module>();
  private defaults = new Map<string, string>();
  private businesses = new Map<string, string>();
  registerBusiness(id: string, hash: string) {
    if (this.businesses.has(id)) throw new Error("BUSINESS_DUPLICATE");
    this.businesses.set(id, hash);
  }
  register(module: Module, options: { default?: boolean } = {}): void {
    if (
      module.runtime?.modelProfile &&
      (!module.runtime.model ||
        !this.modelProfiles[module.runtime.modelProfile])
    )
      throw new Error("MODEL_PROFILE_NOT_FOUND");
    if (
      module.runtime?.contexts?.some((id) => !this.contextProfiles[id]) ||
      (module.runtime?.contexts?.length && !module.runtime.model)
    )
      throw new Error("CONTEXT_PROVIDER_UNAVAILABLE");
    const key = `${module.id}@${module.version}`;
    if (this.modules.has(key)) throw new Error(`Duplicate module ${key}`);
    const names = new Set<string>();
    for (const tool of module.tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
      if (tool.effect === "reconcilable_write" && !tool.reconcile)
        throw new Error(`Missing reconciliation: ${tool.name}`);
      validateReconciliationPolling(tool);
      names.add(tool.name);
    }
    this.modules.set(key, isolateModule(module, this.executionHost));
    if (options.default || !this.defaults.has(module.id))
      this.defaults.set(module.id, module.version);
  }
  next(module: Module, input: Data, steps: Step[], signal: AbortSignal) {
    return nextAction(this.executionHost, module, input, steps, signal);
  }
  get(id: string, version?: string): Module {
    const found = this.modules.get(`${id}@${version ?? this.defaults.get(id)}`);
    if (found) return found;
    const retired = version ? this.retired(id, version) : undefined;
    if (!retired) throw new Problem(422, "MODULE_NOT_AVAILABLE");
    return retired;
  }
  private retiredCache = new Map<string, Module>();
  /** 当前版本声明 previousVersions=read-only 时，为未注册的旧版本生成只读模块（读取任务、不再执行）。 */
  private retired(id: string, version: string): Module | undefined {
    const key = `${id}@${version}`;
    const cached = this.retiredCache.get(key);
    if (cached) return cached;
    const current = this.modules.get(`${id}@${this.defaults.get(id)}`);
    if (
      !current ||
      current.compatibility?.previousVersions !== "read-only" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    )
      return undefined;
    const module: Module = {
      id,
      version,
      title: current.title,
      description: current.description,
      capability: current.capability,
      input: current.input,
      example: current.example,
      tools: [],
      runtime: { model: false },
      ...(current.authorizeRead
        ? { authorizeRead: current.authorizeRead }
        : {}),
      next() {
        throw new Problem(409, "MODULE_VERSION_RETIRED");
      },
    };
    this.retiredCache.set(key, module);
    return module;
  }
  list(): Module[] {
    return [...this.modules.values()];
  }
  active(): Module[] {
    return [...this.defaults].map(([id, version]) => this.get(id, version));
  }
  setDefault(id: string, version: string) {
    this.get(id, version);
    this.defaults.set(id, version);
  }
  deployment() {
    return {
      protocol: 1 as const,
      businesses: Object.fromEntries(
        [...this.businesses].sort(([a], [b]) => a.localeCompare(b)),
      ),
      modules: this.compatible().sort((a, b) =>
        `${a.id}@${a.version}:${a.hash}`.localeCompare(
          `${b.id}@${b.version}:${b.hash}`,
        ),
      ),
      defaults: Object.fromEntries(
        [...this.defaults].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  compatible() {
    return this.list().flatMap((module) => {
      const hashes = new Set([this.hash(module)]);
      if (module.runtime?.acceptLegacyProfile)
        hashes.add(this.hash(module, true));
      return [...hashes].map((hash) => ({
        id: module.id,
        version: module.version,
        hash,
      }));
    });
  }
  accepts(task: {
    module_id: string;
    module_version: string;
    config_hash: string;
  }) {
    return this.compatible().some(
      (m) =>
        m.id === task.module_id &&
        m.version === task.module_version &&
        m.hash === task.config_hash,
    );
  }
  /** 旧指纹仅在原模型配置完全相同时接受；不会迁写旧任务或猜测跨配置兼容。 */
  hash(module: Module, legacy = false): string {
    return fingerprint({
      runtimeProfile:
        legacy || !module.runtime
          ? this.runtimeProfile
          : {
              model: module.runtime.model
                ? module.runtime.modelProfile
                  ? {
                      id: module.runtime.modelProfile,
                      profile: this.modelProfiles[module.runtime.modelProfile],
                    }
                  : this.runtimeProfile
                : null,
              config: module.runtime.config ?? {},
            },
      ...(module.runtime?.pool || module.runtime?.labels?.length
        ? {
            placement: {
              pool: module.runtime.pool ?? "default",
              labels: [...(module.runtime.labels ?? [])].sort(),
            },
          }
        : {}),
      ...(module.runtime?.contexts?.length
        ? {
            contexts: module.runtime.contexts.map((id) => ({
              id,
              profile: this.contextProfiles[id],
            })),
          }
        : {}),
      ...(module.execution ? { execution: module.execution } : {}),
      id: module.id,
      version: module.version,
      capability: module.capability,
      input: z.toJSONSchema(module.input),
      budget: this.budget(module),
      tools: module.tools.map((t) => ({
        name: t.name,
        version: t.version,
        effect: t.effect,
        approval: t.approval ?? false,
        ...(t.deferred ? { deferred: t.deferred } : {}),
        ...(t.continueOnUnknown ? { continueOnUnknown: true } : {}),
        ...(t.reconciliationPolling
          ? { reconciliationPolling: t.reconciliationPolling }
          : {}),
        ...(t.approvalMessage ? { approvalMessage: true } : {}),
        capability: t.capability,
        input: z.toJSONSchema(t.input),
        output: z.toJSONSchema(t.output),
      })),
    });
  }
  budget(module: Module) {
    return { ...defaultBudget, ...module.budget };
  }
}
