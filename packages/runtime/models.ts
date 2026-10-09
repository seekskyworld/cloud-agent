import { modelPolicy } from "./model-lifecycle.js";
import { fingerprint } from "../contracts/fingerprint.js";
/** 模型配置由可信模块选择；每个配置单独提供非秘密指纹，旧任务不得静默换模型。 */
import { Problem, type ModelEngine } from "../contracts/index.js";
export interface ModelProfile {
  capabilities?: readonly string[];
  id: string;
  engine: ModelEngine;
  fingerprint: string;
}
export class ModelProfiles {
  private profiles = new Map<string, ModelProfile>();
  constructor(
    private defaultEngine: ModelEngine,
    entries: ModelProfile[] = [],
  ) {
    const resources = new Map<string, string>();
    for (const engine of [defaultEngine, ...entries.map((e) => e.engine)]) {
      const p = modelPolicy(engine);
      const value = fingerprint({
        concurrency: p.concurrency ?? 16,
        unknownLimit: p.unknownLimit ?? 4,
        quarantineMs: p.quarantineMs ?? 60000,
      });
      if (resources.has(p.resourceId) && resources.get(p.resourceId) !== value)
        throw new Error("MODEL_RESOURCE_POLICY_CONFLICT");
      resources.set(p.resourceId, value);
    }
    for (const entry of entries) {
      if (this.profiles.has(entry.id))
        throw new Error("MODEL_PROFILE_DUPLICATE");
      this.profiles.set(entry.id, entry);
    }
  }
  get(id?: string): ModelEngine {
    if (!id) return this.defaultEngine;
    const profile = this.profiles.get(id);
    if (!profile) throw new Problem(422, "MODEL_PROFILE_NOT_FOUND");
    return profile.engine;
  }
  byEngineId(id: string): ModelEngine | undefined {
    if (this.defaultEngine.id === id) return this.defaultEngine;
    return [...this.profiles.values()].find((p) => p.engine.id === id)?.engine;
  }
  fingerprints() {
    return Object.fromEntries(
      [...this.profiles.values()].map((p) => [p.id, p.fingerprint]),
    );
  }
}
