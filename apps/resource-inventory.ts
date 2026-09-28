import { businessPortIds } from "./business-ports.js";
import {
  ResourceInventory,
  type ResourceDescriptor,
} from "../packages/extensions/inventory.js";
import type { ContainerExtensions } from "./container.js";
import type { Config } from "./config.js";

/** Builds a secret-free inventory without creating provider clients or reading credentials. */
export function configuredResources(
  config: Config,
  extensions: ContainerExtensions = {},
) {
  const entries: ResourceDescriptor[] = [];
  for (const id of extensions.ports
    ? Object.keys(extensions.ports)
    : businessPortIds)
    entries.push({ kind: "port", id, roles: ["api", "worker", "diagnostic"] });
  for (const item of config.connections ?? [])
    entries.push({
      kind: "connection",
      id: item.id,
      roles: ["api", "worker", "diagnostic"],
    });
  for (const item of config.modelProfiles ?? [])
    entries.push({
      kind: "model",
      id: item.id,
      roles: ["worker", "diagnostic"],
    });
  for (const item of config.channels ?? [])
    entries.push({
      kind: "channel",
      id: item.id,
      roles: ["worker", "diagnostic"],
    });
  for (const item of config.mailAccounts ?? [])
    entries.push({
      kind: "mail",
      id: item.id,
      roles: ["worker", "diagnostic"],
    });
  for (const item of [
    config.artifactConfig,
    ...(config.artifactConfigs ?? []),
  ].filter(Boolean))
    entries.push({
      kind: "artifacts",
      id: String(item!.id),
      roles: ["api", "worker", "diagnostic"],
    });
  for (const item of extensions.artifactStores ?? [])
    entries.push({
      kind: "artifacts",
      id: item.id,
      identity: item.identity,
      roles: ["api", "worker"],
    });
  for (const item of extensions.contexts ?? [])
    entries.push({
      kind: "context",
      id: item.id,
      identity: item.identity,
      roles: ["worker"],
    });
  return new ResourceInventory(entries);
}
