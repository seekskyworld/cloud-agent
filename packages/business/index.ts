/** 业务包只依赖公共协议；依赖用逻辑名称声明，由宿主绑定具体设施。 */
import type {
  BusinessInstance,
  BusinessMigration,
  PortToken,
} from "./application.js";
import { z } from "zod";
import type { Data, ExecutionContext, Json } from "../contracts/index.js";
export const SDK_MAJOR = 1;
export type ResourceKind =
  | "connection"
  | "model"
  | "artifacts"
  | "context"
  | "channel"
  | "port";
export interface Requirement {
  kind: ResourceKind;
  optional?: boolean;
  protocol?: { id: string; version: number };
}
export interface BusinessServices {
  port<T>(alias: string, token: PortToken<T>): T;
  connection(alias: string): {
    request(
      path: string,
      context: ExecutionContext,
      body?: Data,
    ): Promise<Json>;
  };
  model(alias: string): string;
  context(alias: string): string;
  channel(alias: string): string;
  files(alias: string): {
    put(
      context: ExecutionContext,
      name: string,
      mediaType: string,
      data: Uint8Array,
    ): Promise<Data>;
  };
}
export interface BusinessPackage {
  id: string;
  version: string;
  sdkMajor: number;
  permissions: readonly string[];
  config: z.ZodType;
  requires: Readonly<Record<string, Requirement>>;
  migrations?: readonly BusinessMigration[];
  create(
    config: unknown,
    services: BusinessServices,
  ): BusinessInstance | Promise<BusinessInstance>;
}
export function defineBusinessPackage<S extends z.ZodType>(
  value: Omit<BusinessPackage, "config" | "create"> & {
    config: S;
    create(
      config: z.output<S>,
      services: BusinessServices,
    ): ReturnType<BusinessPackage["create"]>;
  },
): BusinessPackage {
  if (value.sdkMajor !== SDK_MAJOR)
    throw new Error("BUSINESS_SDK_INCOMPATIBLE");
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) ||
    !/^\d+\.\d+\.\d+$/.test(value.version)
  )
    throw new Error("BUSINESS_ID_INVALID");
  return {
    ...value,
    create: (config, services) =>
      value.create(value.config.parse(config), services),
  };
}
const Deployment = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.json()).default({}),
    jobs: z
      .record(
        z.string(),
        z
          .object({
            workspace: z.string().min(1),
            principal: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    bindings: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();
export type BusinessDeployment = z.infer<typeof Deployment>;
export function loadBusinessDeployments(
  raw: string | undefined,
): BusinessDeployment[] {
  try {
    const values = z
      .array(Deployment)
      .max(100)
      .parse(JSON.parse(raw || "[]"));
    if (new Set(values.map((x) => x.id)).size !== values.length)
      throw new Error("duplicate");
    return values;
  } catch {
    throw new Error("BUSINESS_CONFIG_INVALID");
  }
}
export function resolveBusiness(
  manifest: BusinessPackage,
  deployment: BusinessDeployment,
) {
  if (manifest.sdkMajor !== SDK_MAJOR)
    throw new Error("BUSINESS_SDK_INCOMPATIBLE");
  const value = manifest.config.safeParse(deployment.config);
  if (!value.success) throw new Error("BUSINESS_CONFIG_INVALID");
  for (const alias of Object.keys(deployment.bindings))
    if (!manifest.requires[alias]) throw new Error("BUSINESS_BINDING_UNKNOWN");
  for (const [alias, requirement] of Object.entries(manifest.requires))
    if (!requirement.optional && !deployment.bindings[alias])
      throw new Error("BUSINESS_BINDING_REQUIRED");
  return value.data;
}
