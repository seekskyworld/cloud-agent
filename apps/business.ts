/** 业务资源别名只绑定可信部署配置；包配置与实际依赖身份一起进入恢复指纹。 */
import type {
  BusinessApplications,
  BusinessInstance,
  PortBinding,
} from "../packages/business/application.js";
import { fingerprint } from "../packages/persistence/database.js";
import {
  resolveBusiness,
  type BusinessPackage,
  type BusinessDeployment,
  type BusinessServices,
  SDK_MAJOR,
  type Requirement,
} from "../packages/business/index.js";
import type { Connections } from "../packages/connections/index.js";
import type { ArtifactFiles } from "../packages/artifacts/index.js";
import type { ModelProfiles } from "../packages/runtime/models.js";
import type { Resources } from "../packages/extensions/registry.js";
import type { Registry } from "../packages/runtime/registry.js";
import { DomainHttp } from "../adapters/http/client.js";
export interface BusinessHost {
  inventory?: import("../packages/extensions/inventory.js").ResourceInventory;
  connections: Connections;
  files?: ArtifactFiles;
  stores?: Map<string, ArtifactFiles>;
  ports?: Record<string, PortBinding>;
  applications?: BusinessApplications;
  models: ModelProfiles;
  contexts?: Record<string, string>;
  channels: Record<string, string>;
}
function bindings(
  manifest: BusinessPackage,
  deployment: BusinessDeployment,
  host: BusinessHost,
) {
  const identities: Record<string, unknown> = {};
  for (const [alias, requirement] of Object.entries(manifest.requires)) {
    const id = deployment.bindings[alias];
    if (!id && requirement.optional) continue;
    if (!id) throw new Error("BUSINESS_BINDING_REQUIRED");
    if (requirement.capabilities?.length || requirement.kind === "mail") {
      if (!host.inventory) throw new Error("RESOURCE_INVENTORY_REQUIRED");
      host.inventory.require(requirement.kind, id, requirement.capabilities);
    }
    const value = resourceIdentity(requirement, id, host);
    if (value === undefined) throw new Error("BUSINESS_DEPENDENCY_MISSING");
    identities[alias] = { kind: requirement.kind, id, identity: value };
  }
  return identities;
}
function resourceIdentity(
  requirement: Requirement,
  id: string,
  host: BusinessHost,
) {
  let value: unknown;
  switch (requirement.kind) {
    case "port": {
      const port = host.ports?.[id];
      if (
        !port ||
        port.token !== requirement.protocol?.id ||
        port.version !== requirement.protocol.version
      )
        throw new Error("BUSINESS_PORT_INCOMPATIBLE");
      value = {
        token: port.token,
        version: port.version,
        identity: port.identity,
      };
      break;
    }
    case "mail":
      value = mailIdentity(host, id);
      break;
    case "connection":
      value = host.connections.definitions.find((c) => c.id === id);
      break;
    case "model":
      value = host.models.fingerprints()[id];
      break;
    case "artifacts":
      value = (
        host.stores?.get(id) ??
        (host.files?.store.id === id ? host.files : undefined)
      )?.store.identity;
      break;
    case "context":
      value = host.contexts?.[id];
      break;
    case "channel":
      value = host.channels[id];
      break;
  }

  return value;
}

function services(
  manifest: BusinessPackage,
  deployment: BusinessDeployment,
  host: BusinessHost,
): BusinessServices {
  const lookup = (alias: string, kind: string) => {
    const id = deployment.bindings[alias];
    if (manifest.requires[alias]?.kind !== kind || !id)
      throw new Error("BUSINESS_DEPENDENCY_UNDECLARED");
    return id;
  };
  return {
    port(alias, token) {
      const binding = host.ports?.[lookup(alias, "port")];
      if (
        !binding ||
        binding.token !== token.id ||
        binding.version !== token.version ||
        !token.check(binding.value)
      )
        throw new Error("BUSINESS_PORT_INCOMPATIBLE");
      return binding.value;
    },
    connection(alias) {
      const client = new DomainHttp(
        lookup(alias, "connection"),
        "",
        host.connections,
      );
      return {
        request: (path, context, body) => client.json(path, context, body),
      };
    },
    model: (alias) => lookup(alias, "model"),
    context: (alias) => lookup(alias, "context"),
    channel: (alias) => lookup(alias, "channel"),
    mail: (alias) => lookup(alias, "mail"),
    files(alias) {
      const id = lookup(alias, "artifacts");
      const files =
        host.stores?.get(id) ??
        (host.files?.store.id === id ? host.files : undefined);
      if (!files) throw new Error("ARTIFACT_STORE_DISABLED");
      return {
        put: (context, name, mediaType, data) =>
          files.put(context, name, mediaType, Buffer.from(data)),
      };
    },
  };
}
export function businessPermissions(
  catalog: BusinessPackage[],
  deployments: BusinessDeployment[],
) {
  return deployments
    .filter((d) => d.enabled)
    .flatMap((d) => {
      const manifest = catalog.find((p) => p.id === d.id);
      if (!manifest) throw new Error("BUSINESS_NOT_REGISTERED");
      return [...manifest.permissions];
    });
}
export async function assembleBusiness(
  catalog: BusinessPackage[],
  deployments: BusinessDeployment[],
  host: BusinessHost,
  registry: Registry,
  resources: Resources,
) {
  if (new Set(catalog.map((p) => p.id)).size !== catalog.length)
    throw new Error("BUSINESS_DUPLICATE");
  for (const deployment of deployments.filter((d) => d.enabled)) {
    const manifest = catalog.find((p) => p.id === deployment.id);
    if (!manifest) throw new Error("BUSINESS_NOT_REGISTERED");
    const config = resolveBusiness(manifest, deployment),
      dependencies = bindings(manifest, deployment, host);
    const instance = await manifest.create(
      config,
      services(manifest, deployment, host),
    );
    if (instance.close) resources.add(() => instance.close!());
    host.applications?.add(manifest.id, manifest.permissions, instance);
    for (const module of instance.modules) {
      if (
        [module.capability, ...module.tools.map((t) => t.capability)].some(
          (cap) => !manifest.permissions.includes(cap),
        )
      )
        throw new Error("BUSINESS_PERMISSION_UNDECLARED");
      if (!module.runtime) throw new Error("BUSINESS_RUNTIME_REQUIRED");
      const declared = (kind: string, id: string | undefined) =>
        Object.entries(manifest.requires).some(
          ([alias, r]) => r.kind === kind && deployment.bindings[alias] === id,
        );
      if (
        module.runtime.model &&
        (!module.runtime.modelProfile ||
          !declared("model", module.runtime.modelProfile))
      )
        throw new Error("BUSINESS_MODEL_UNDECLARED");
      if (module.runtime.contexts?.some((id) => !declared("context", id)))
        throw new Error("BUSINESS_CONTEXT_UNDECLARED");
      registry.register({
        ...module,
        runtime: {
          ...module.runtime,
          config: {
            ...module.runtime.config,
            business: fingerprint({
              id: manifest.id,
              version: manifest.version,
              sdk: SDK_MAJOR,
              ...selectedDependencies(
                config,
                dependencies,
                instance.dependencies?.[module.id],
              ),
            }),
          },
        },
      });
    }
    registry.registerBusiness(
      manifest.id,
      fingerprint({
        version: manifest.version,
        config,
        dependencies,
        routes: (instance.routes ?? []).map((r) => ({
          id: r.id,
          method: r.method,
          capability: r.capability,
          input: r.input.toJSONSchema(),
          output: r.output.toJSONSchema(),
        })),
        ...additionalContributions(instance),
        jobs: instance.jobs ?? [],
        pages: instance.pages ?? [],
      }),
    );
  }
  return businessPermissions(catalog, deployments);
}

function selectedDependencies(
  config: unknown,
  dependencies: Record<string, unknown>,
  selection?: { bindings: string[]; config: string[] },
) {
  if (!selection) return { config, dependencies };
  if (!config || typeof config !== "object")
    throw new Error("BUSINESS_CONFIG_NOT_OBJECT");
  const values = config as Record<string, unknown>;
  if (
    selection.bindings.some((key) => !(key in dependencies)) ||
    selection.config.some((key) => !(key in values))
  )
    throw new Error("BUSINESS_DEPENDENCY_SELECTION_INVALID");
  return {
    config: Object.fromEntries(
      selection.config.map((key) => [key, values[key]]),
    ),
    dependencies: Object.fromEntries(
      selection.bindings.map((key) => [key, dependencies[key]]),
    ),
  };
}

function additionalContributions(instance: BusinessInstance) {
  return {
    ...((instance.dataResources?.length ?? 0)
      ? { dataResources: instance.dataResources }
      : {}),
    ...((instance.publicReads?.length ?? 0)
      ? {
          publicReads: instance.publicReads!.map((r) => ({
            id: r.id,
            input: r.input.toJSONSchema(),
            output: r.output.toJSONSchema(),
          })),
        }
      : {}),
    ...((instance.checks?.length ?? 0)
      ? { checks: instance.checks!.map(({ id, phase }) => ({ id, phase })) }
      : {}),
  };
}

function mailIdentity(host: BusinessHost, id: string) {
  const entry = host.inventory?.get("mail", id);
  return entry ? (entry.identity ?? id) : undefined;
}
