/** 模型配置由可信模块选择；每个配置单独提供非秘密指纹，旧任务不得静默换模型。 */
import { Problem, type ModelEngine } from "../contracts/index.js";
export interface ModelProfile {
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
  fingerprints() {
    return Object.fromEntries(
      [...this.profiles.values()].map((p) => [p.id, p.fingerprint]),
    );
  }
}
