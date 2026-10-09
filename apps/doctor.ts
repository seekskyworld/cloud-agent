import type { ContainerExtensions } from "./container.js";
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
export async function diagnose(
  config: Config,
  extensions: ContainerExtensions = {},
  scope:
    | "configuration"
    | "configuration-and-credentials" = "configuration-and-credentials",
) {
  const plan = configuredResources(config, extensions);
  config = effectiveDiagnosticConfig(config, extensions);
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
    checks.push({
      component,
      ...(scope === "configuration"
        ? { status: "passed" as const, ok: true, code: "CONFIG_VALID" }
        : await run()),
    });
  for (const c of config.connections ?? []) {
    try {
      const signal = AbortSignal.timeout(5000);
      if (scope !== "configuration")
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
  for (const entry of plan
    .list()
    .filter(
      (e) =>
        e.ownership === "caller" ||
        extensions.factoryResources?.some(
          (d) => d.kind === e.kind && d.id === e.id,
        ),
    ))
    checks.push({
      component: `${entry.kind}:${entry.id}`,
      status: "unchecked",
      ok: false,
      code: "INJECTED_RESOURCE_NOT_PROBED",
    });
  checks.push(...diagnoseBusiness(config, extensions, plan));
  return {
    ok: checks.every((c) => c.ok),
    scope,
    resources: plan.list(),
    checks,
  };
}

function diagnoseBusiness(
  config: Config,
  extensions: ContainerExtensions,
  plan: ReturnType<typeof configuredResources>,
): (Diagnostic & { component: string })[] {
  return (config.businesses ?? [])
    .filter((d) => d.enabled)
    .map((deployment) => {
      try {
        const manifest = (extensions.businesses ?? businessPackages).find(
          (p) => p.id === deployment.id,
        );
        if (!manifest) throw new Error("BUSINESS_NOT_REGISTERED");
        resolveBusiness(manifest, deployment);
        for (const [alias, requirement] of Object.entries(manifest.requires)) {
          const id = deployment.bindings[alias];
          if (id)
            plan.require(
              requirement.kind,
              id,
              requirement.capabilities,
              requirement.protocol,
            );
        }
        return {
          component: `business:${deployment.id}`,
          status: "passed",
          ok: true,
          code: "CONFIG_VALID",
        };
      } catch {
        return {
          component: `business:${deployment.id}`,
          status: "failed",
          ok: false,
          code: "BUSINESS_CONFIG_INVALID",
        };
      }
    });
}

function effectiveDiagnosticConfig(
  config: Config,
  extensions: ContainerExtensions,
): Config {
  return {
    ...config,
    mailAccounts:
      extensions.mailFactory ||
      extensions.mails ||
      extensions.mail ||
      config.mail
        ? []
        : config.mailAccounts,
    channels: extensions.channels ? [] : config.channels,
    modelProfiles: extensions.modelProfiles ? [] : config.modelProfiles,
    artifactConfig: extensions.artifactStore
      ? undefined
      : config.artifactConfig,
  };
}
