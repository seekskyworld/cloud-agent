import { businessPortIds } from "./business-ports.js";
import { abortable } from "../packages/contracts/lifecycle.js";
/** 离线诊断由扩展自述；未知实现明确未检查，不实例化有潜在副作用的连接器。 */
import {
  artifactProviders,
  channelProviders,
  mailProviders,
  modelProviders,
} from "./extensions.js";
import { Connections } from "../packages/connections/index.js";
import type { Diagnostic } from "../packages/extensions/registry.js";
import type { Config } from "./config.js";
import { businessPackages } from "../modules/packages.js";
import { resolveBusiness } from "../packages/business/index.js";
import { configuredResources } from "./resource-inventory.js";
export async function diagnose(config: Config) {
  const checks: (Diagnostic & { component: string })[] = [];
  const secrets =
    config.secrets ??
    (async () => {
      throw new Error("missing");
    });
  const connections = new Connections(
    config.connections ?? [],
    secrets,
    async () => {
      throw new Error("offline");
    },
  );
  const add = async (component: string, run: () => Promise<Diagnostic>) =>
    checks.push({ component, ...(await run()) });
  for (const c of config.connections ?? []) {
    try {
      const signal = AbortSignal.timeout(5000);
      await abortable(signal, () => connections.diagnose(c.id, signal));
      checks.push({
        component: `connection:${c.id}`,
        status: "passed",
        ok: true,
        code: "OK",
      });
    } catch {
      checks.push({
        component: `connection:${c.id}`,
        status: "failed",
        ok: false,
        code: "CONFIG_OR_CREDENTIAL_UNAVAILABLE",
      });
    }
  }
  for (const c of config.mailAccounts ?? [])
    await add(`mail:${c.id}`, () =>
      mailProviders.diagnose(c.provider, c.options, {
        credentials:
          config.mailCredentials ??
          (async () => {
            throw new Error("missing");
          }),
      }),
    );
  for (const c of config.channels ?? [])
    await add(`channel:${c.id}`, () =>
      channelProviders.diagnose(c.provider, c.options, secrets),
    );
  for (const c of config.modelProfiles ?? [])
    await add(`model:${c.id}`, () =>
      modelProviders.diagnose(c.provider, c, connections),
    );
  if (config.artifactConfig) {
    const c = config.artifactConfig;
    await add("artifacts", () =>
      artifactProviders.diagnose(c.provider, c, secrets),
    );
  }
  for (const c of config.artifactConfigs ?? [])
    await add(`artifacts:${c.id}`, () =>
      artifactProviders.diagnose(c.provider, c, secrets),
    );
  checks.push(...diagnoseBusiness(config));
  return {
    ok: checks.every((c) => c.ok),
    scope: "configuration-and-credentials",
    checks,
  };
}

function diagnoseBusiness(
  config: Config,
): (Diagnostic & { component: string })[] {
  const checks: (Diagnostic & { component: string })[] = [];
  const configured = (() => {
    try {
      return configuredResources(config).byKind();
    } catch {
      return undefined;
    }
  })();
  for (const deployment of (config.businesses ?? []).filter((d) => d.enabled)) {
    try {
      const manifest = businessPackages.find((p) => p.id === deployment.id);
      if (!manifest) throw new Error("missing");
      resolveBusiness(manifest, deployment);
      const inventory: Record<string, unknown[]> = configured ?? {
        connection: (config.connections ?? []).map((c) => c.id),
        model: (config.modelProfiles ?? []).map((c) => c.id),
        channel: (config.channels ?? []).map((c) => c.id),
        artifacts: [
          ...(config.artifactConfig ? [config.artifactConfig.id] : []),
          ...(config.artifactConfigs ?? []).map((c) => c.id),
        ],
        context: config.memoryEnabled ? ["memory"] : [],
        port: businessPortIds,
      };
      for (const [alias, requirement] of Object.entries(manifest.requires)) {
        const id = deployment.bindings[alias];
        if (id && !inventory[requirement.kind]?.includes(id))
          throw new Error("missing");
      }
      checks.push({
        component: `business:${deployment.id}`,
        status: "passed",
        ok: true,
        code: "CONFIG_VALID",
      });
    } catch {
      checks.push({
        component: `business:${deployment.id}`,
        status: "failed",
        ok: false,
        code: "BUSINESS_CONFIG_INVALID",
      });
    }
  }

  return checks;
}
