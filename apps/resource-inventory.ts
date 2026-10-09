import { businessPortIds } from "./business-ports.js";
import {
  mailProviders,
  modelProviders,
  channelProviders,
  artifactProviders,
} from "./extensions.js";
import { mailCapabilities } from "../packages/mail/contracts.js";
import {
  ResourceInventory,
  type ResourceDescriptor,
  type ResourceKind,
} from "../packages/extensions/inventory.js";
import type { ModelEngine } from "../packages/contracts/index.js";
import type { ContainerExtensions } from "./container.js";
import type { Config } from "./config.js";
export function engineCapabilities(engine: ModelEngine) {
  return [
    "text",
    ...(engine.control ? ["remote-control"] : []),
    ...(engine.capabilities?.progress || engine.stream ? ["progress"] : []),
    ...(engine.capabilities?.structuredOutput ? ["structured-output"] : []),
  ];
}
/** 配置与显式注入使用相同覆盖规则；工厂结果未知时只接受调用方声明，不执行工厂探测。 */
export function configuredResources(
  config: Config,
  extensions: ContainerExtensions = {},
) {
  const builder = new InventoryBuilder();
  builder.entries.push({
    kind: "engine",
    id: "default",
    roles: ["api", "worker", "maintenance", "diagnostic"],
    ownership: extensions.engine ? "caller" : "host",
    identity: extensions.engine?.id,
    capabilities: extensions.engine
      ? engineCapabilities(extensions.engine)
      : ["text"],
  });
  builder.ports(config, extensions);
  builder.models(config, extensions);
  builder.channels(config, extensions);
  builder.mail(config, extensions);
  builder.artifacts(config, extensions);
  builder.contexts(config, extensions);
  return new ResourceInventory(builder.entries);
}
class InventoryBuilder {
  readonly entries: ResourceDescriptor[] = [];
  add = (
    kind: ResourceKind,
    id: string,
    capabilities: readonly string[] = [],
    injected = false,
    identity?: string,
    dependencies: string[] = [],
    protocol?: { id: string; version: number },
  ) =>
    this.entries.push({
      kind,
      id,
      capabilities,
      identity,
      dependencies,
      protocol,
      roles: ["api", "worker", "maintenance", "diagnostic"],
      ownership: injected ? "caller" : "host",
      phase: injected ? "ready" : "declared",
    });
  caps = (
    providers: {
      describe(): { id: string; capabilities: readonly string[] }[];
    },
    provider: string,
  ) => providers.describe().find((p) => p.id === provider)?.capabilities ?? [];
  ports(config: Config, extensions: ContainerExtensions) {
    if (extensions.portFactory)
      this.entries.push(
        ...(extensions.factoryResources ?? [])
          .filter((e) => e.kind === "port")
          .map((e) => ({
            ...e,
            ownership: "host" as const,
            phase: "declared" as const,
          })),
      );
    else
      for (const id of extensions.ports
        ? Object.keys(extensions.ports)
        : businessPortIds)
        this.add(
          "port",
          id,
          extensions.ports?.[id]?.capabilities,
          true,
          extensions.ports?.[id]?.identity,
          [],
          extensions.ports?.[id]
            ? {
                id: extensions.ports[id]!.token,
                version: extensions.ports[id]!.version,
              }
            : undefined,
        );
    for (const c of config.connections ?? [])
      this.add("connection", c.id, ["request"]);
  }
  models(config: Config, extensions: ContainerExtensions) {
    if (extensions.modelProfiles)
      for (const p of extensions.modelProfiles)
        this.add(
          "model",
          p.id,
          [
            ...new Set([
              ...engineCapabilities(p.engine),
              ...(p.capabilities ?? []),
            ]),
          ],
          true,
          p.fingerprint,
        );
    else
      for (const p of config.modelProfiles ?? [])
        this.add(
          "model",
          p.id,
          [
            ...this.caps(modelProviders, p.provider),
            ...(p.managed ? ["remote-control"] : []),
          ],
          false,
          undefined,
          modelProviders
            .references(p.provider, p)
            .filter((r) => r.kind === "connection")
            .map((r) => `connection:${r.id}`),
        );
  }
  channels(config: Config, extensions: ContainerExtensions) {
    if (extensions.channels)
      for (const c of extensions.channels)
        this.add(
          "channel",
          c.settings.id,
          ["receive", "send", "webhook"],
          true,
        );
    else
      for (const c of config.channels ?? [])
        this.add("channel", c.id, this.caps(channelProviders, c.provider));
  }
  mail(config: Config, extensions: ContainerExtensions) {
    if (extensions.mailFactory)
      this.entries.push(
        ...(extensions.factoryResources ?? [])
          .filter((e) => e.kind === "mail")
          .map((e) => ({
            ...e,
            ownership: "host" as const,
            phase: "declared" as const,
          })),
      );
    else if (extensions.mails || extensions.mail)
      for (const m of extensions.mails ?? [extensions.mail!])
        this.add(
          "mail",
          m.settings.id ?? m.settings.inbox,
          mailCapabilities(m.provider),
          true,
          m.settings.accountFingerprint,
        );
    else if (config.mail)
      this.add("mail", config.mail.id ?? config.mail.inbox, [
        "send",
        "receive",
        "webhook",
      ]);
    else
      for (const m of config.mailAccounts ?? [])
        this.add("mail", m.id, this.caps(mailProviders, m.provider));
  }
  artifacts(config: Config, extensions: ContainerExtensions) {
    if (extensions.artifactStore)
      this.add(
        "artifacts",
        extensions.artifactStore.id,
        ["read", "write", "delete"],
        true,
        extensions.artifactStore.identity,
      );
    else if (config.artifactConfig)
      this.add(
        "artifacts",
        String(config.artifactConfig.id),
        this.caps(artifactProviders, String(config.artifactConfig.provider)),
      );
    for (const c of config.artifactConfigs ?? [])
      this.add(
        "artifacts",
        String(c.id),
        this.caps(artifactProviders, String(c.provider)),
      );
    for (const c of extensions.artifactStores ?? [])
      this.add(
        "artifacts",
        c.id,
        ["read", "write", "delete"],
        true,
        c.identity,
      );
  }
  contexts(config: Config, extensions: ContainerExtensions) {
    for (const c of extensions.contexts ?? [])
      this.add("context", c.id, ["read"], true, c.identity);
    if (config.memoryEnabled) this.add("context", "memory", ["read"]);
  }
}
export function verifyFactoryResources(
  planned: ResourceInventory,
  actual: ResourceInventory,
  kinds: ResourceKind[],
) {
  for (const kind of kinds) {
    const before = planned.list().filter((e) => e.kind === kind),
      after = actual.list().filter((e) => e.kind === kind);
    if (before.length !== after.length)
      throw new Error("FACTORY_RESOURCE_MISMATCH");
    for (const entry of before) {
      const found = actual.require(
        kind,
        entry.id,
        entry.capabilities,
        entry.protocol,
      );
      if (entry.identity && entry.identity !== found.identity)
        throw new Error("FACTORY_RESOURCE_MISMATCH");
    }
  }
}

export function resolvedResources(
  config: Config,
  extensions: ContainerExtensions,
  planned: ResourceInventory,
  actual: Pick<
    ContainerExtensions,
    "ports" | "mails" | "modelProfiles" | "engine"
  >,
) {
  const inventory = configuredResources(config, {
    ...extensions,
    ...actual,
    portFactory: undefined,
    mailFactory: undefined,
  });
  verifyFactoryResources(planned, inventory, [
    ...(extensions.portFactory ? ["port" as const] : []),
    ...(extensions.mailFactory ? ["mail" as const] : []),
  ]);
  return new ResourceInventory(
    inventory.list().map((entry) => ({
      ...entry,
      ownership:
        planned.get(entry.kind, entry.id)?.ownership ?? entry.ownership,
    })),
  );
}
