export type ResourceKind =
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
  roles: readonly ResourceRole[];
  dependencies?: readonly string[];
}

/** Validated, secret-free inventory shared by startup, diagnostics and deployment fingerprints. */
export class ResourceInventory {
  private readonly values = new Map<string, ResourceDescriptor>();
  constructor(entries: readonly ResourceDescriptor[] = []) {
    for (const entry of entries) this.add(entry);
    this.validateDependencies();
  }
  add(entry: ResourceDescriptor) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(entry.id) || !entry.roles.length)
      throw new Error("RESOURCE_DESCRIPTOR_INVALID");
    const key = `${entry.kind}:${entry.id}`;
    if (this.values.has(key)) throw new Error("RESOURCE_DUPLICATE");
    this.values.set(
      key,
      Object.freeze({
        ...entry,
        dependencies: [...(entry.dependencies ?? [])],
        roles: [...entry.roles],
      }),
    );
    return this;
  }
  private validateDependencies() {
    const keys = new Set(this.values.keys());
    for (const entry of this.values.values())
      for (const dependency of entry.dependencies ?? [])
        if (!keys.has(dependency))
          throw new Error("RESOURCE_DEPENDENCY_MISSING");
  }
  list(role?: ResourceRole) {
    return [...this.values.values()].filter(
      (entry) => !role || entry.roles.includes(role),
    );
  }
  byKind() {
    return Object.fromEntries(
      [
        "connection",
        "model",
        "channel",
        "mail",
        "artifacts",
        "context",
        "port",
      ].map((kind) => [
        kind,
        this.list()
          .filter((entry) => entry.kind === kind)
          .map((entry) => entry.id),
      ]),
    ) as Record<ResourceKind, string[]>;
  }
  identities() {
    return Object.fromEntries(
      [...this.values].map(([key, entry]) => [key, entry.identity ?? null]),
    );
  }
}
