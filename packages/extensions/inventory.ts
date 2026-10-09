export type ResourceKind =
  | "engine"
  | "connection"
  | "model"
  | "channel"
  | "mail"
  | "artifacts"
  | "context"
  | "port";
export type ResourceRole = "api" | "worker" | "maintenance" | "diagnostic";
export interface ResourceDescriptor {
  kind: ResourceKind;
  id: string;
  identity?: string;
  protocol?: { id: string; version: number };
  roles: readonly ResourceRole[];
  dependencies?: readonly string[];
  capabilities?: readonly string[];
  ownership?: "host" | "caller";
  phase?: "declared" | "ready";
}
/** 不含凭据的不可变计划；诊断不调用工厂，启动后对照实际产物再次校验。 */
export class ResourceInventory {
  private readonly values = new Map<string, ResourceDescriptor>();
  constructor(entries: readonly ResourceDescriptor[] = []) {
    for (const entry of entries) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_@.+-]{0,319}$/.test(entry.id) ||
        !entry.roles.length
      )
        throw new Error("RESOURCE_DESCRIPTOR_INVALID");
      const key = `${entry.kind}:${entry.id}`;
      if (this.values.has(key)) throw new Error("RESOURCE_DUPLICATE");
      this.values.set(
        key,
        Object.freeze({
          ...entry,
          protocol: entry.protocol
            ? Object.freeze({ ...entry.protocol })
            : undefined,
          dependencies: Object.freeze([...(entry.dependencies ?? [])]),
          capabilities: Object.freeze([...(entry.capabilities ?? [])]),
          roles: Object.freeze([...entry.roles]),
        }),
      );
    }
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw new Error("RESOURCE_DEPENDENCY_CYCLE");
      if (visited.has(key)) return;
      const entry = this.values.get(key);
      if (!entry) throw new Error("RESOURCE_DEPENDENCY_MISSING");
      visiting.add(key);
      for (const dependency of entry.dependencies ?? []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of this.values.keys()) visit(key);
  }
  get(kind: ResourceKind, id: string) {
    return this.values.get(`${kind}:${id}`);
  }
  require(
    kind: ResourceKind,
    id: string,
    capabilities: readonly string[] = [],
    protocol?: { id: string; version: number },
  ) {
    const entry = this.get(kind, id);
    if (!entry) throw new Error("BUSINESS_DEPENDENCY_MISSING");
    if (capabilities.some((c) => !entry.capabilities?.includes(c)))
      throw new Error("RESOURCE_CAPABILITY_MISSING");
    if (
      protocol &&
      (entry.protocol?.id !== protocol.id ||
        entry.protocol.version !== protocol.version)
    )
      throw new Error("BUSINESS_PORT_INCOMPATIBLE");
    return entry;
  }
  list(role?: ResourceRole) {
    return [...this.values.values()].filter(
      (e) => !role || e.roles.includes(role),
    );
  }
  byKind() {
    return Object.fromEntries(
      (
        [
          "engine",
          "connection",
          "model",
          "channel",
          "mail",
          "artifacts",
          "context",
          "port",
        ] as const
      ).map((kind) => [
        kind,
        this.list()
          .filter((e) => e.kind === kind)
          .map((e) => e.id),
      ]),
    ) as Record<ResourceKind, string[]>;
  }
  identities() {
    return Object.fromEntries(
      [...this.values].map(([key, entry]) => [key, entry.identity ?? null]),
    );
  }
}
