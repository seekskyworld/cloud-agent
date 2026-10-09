import { OidcConfig } from "../adapters/identity/oidc.js";
/** 框架启动配置；业务连接由模块自己的适配层显式注入。 */
import "dotenv/config";
import {
  loadBusinessDeployments,
  type BusinessDeployment,
} from "../packages/business/index.js";
import type { DispatchPolicy } from "../packages/runtime/admission.js";
import { loadModelProfiles, ModelOptions } from "./models.js";
import { loadArtifacts } from "./artifacts.js";
import { loadChannels } from "./channel-config.js";
import { loadConnections } from "./connections.js";
import { environmentSecrets } from "../adapters/credentials/environment.js";
import type {
  Connection,
  SecretProvider,
} from "../packages/connections/index.js";
import type { ChannelAccountConfig } from "./channel-config.js";
import { z } from "zod";
import { loadMailAccounts, type MailAccountConfig } from "./mail-accounts.js";
import {
  createMailCredentials,
  type MailCredentials,
} from "./mail-credentials.js";
import { loadMailConfig, type MailConfig } from "./mail-config.js";
const Schema = z.object({
  EXAMPLES_ENABLED: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1),
  AUTH_MODE: z.enum(["none", "token"]).default("none"),
  LOCAL_WORKSPACE: z.string().min(1).default("default"),
  LOCAL_PRINCIPAL: z.string().min(1).default("owner"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  MODEL_MODE: z.enum(["demo", "pi"]).default("demo"),
  LLM_BASE_URL: z.url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  LLM_INPUT_PRICE: z.coerce.number().positive().default(1),
  LLM_OUTPUT_PRICE: z.coerce.number().positive().default(4),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
});
export type Config = Omit<z.infer<typeof Schema>, "EXAMPLES_ENABLED"> & {
  modelOptions?: z.infer<typeof ModelOptions>;
  workerPool?: string;
  workerLabels?: string[];
  tenantRatePerMinute?: number;
  memoryEnabled?: boolean;
  oidc?: z.infer<typeof OidcConfig>;
  telemetryEndpoint?: string;
  costPolicy?: import("../packages/observability/costs.js").CostPolicy;
  managedDeployment?: boolean;
  businesses?: BusinessDeployment[];
  EXAMPLES_ENABLED?: "true" | "false";
  dispatchPolicy?: DispatchPolicy;
  modelProfiles?: ReturnType<typeof loadModelProfiles>;
  artifactConfigs?: NonNullable<ReturnType<typeof loadArtifacts>>[];
  artifactConfig?: ReturnType<typeof loadArtifacts>;
  artifactRetentionDays?: number;
  connections?: Connection[];
  secrets?: SecretProvider;
  channels?: ChannelAccountConfig[];
  mail?: MailConfig;
  mailAccounts?: MailAccountConfig[];
  mailCredentials?: MailCredentials;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = Schema.parse(env);
  if (config.MODEL_MODE === "pi" && !config.LLM_API_KEY)
    throw new Error("LLM_API_KEY required for pi mode");
  return {
    ...config,
    modelOptions: ModelOptions.parse(JSON.parse(env.MODEL_OPTIONS || "{}")),
    workerPool: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .default("default")
      .parse(env.EXECUTION_POOL),
    workerLabels: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
      .max(30)
      .parse(JSON.parse(env.EXECUTION_LABELS || "[]")),
    tenantRatePerMinute: env.TENANT_RATE_PER_MINUTE
      ? z.coerce.number().int().positive().parse(env.TENANT_RATE_PER_MINUTE)
      : undefined,
    memoryEnabled:
      z.enum(["true", "false"]).default("false").parse(env.MEMORY_ENABLED) ===
      "true",
    oidc: env.OIDC_AUTH
      ? OidcConfig.parse(JSON.parse(env.OIDC_AUTH))
      : undefined,
    telemetryEndpoint: z
      .url()
      .optional()
      .parse(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || undefined),
    costPolicy: z
      .object({
        workspaces: z.record(z.string(), z.number().positive()),
        modules: z.record(z.string(), z.number().positive()).optional(),
      })
      .strict()
      .parse(JSON.parse(env.COST_POLICY || '{"workspaces":{}}')),
    managedDeployment:
      z
        .enum(["true", "false"])
        .default("false")
        .parse(env.DEPLOYMENT_MANAGED) === "true",
    businesses: loadBusinessDeployments(env.BUSINESS_PACKAGES),
    dispatchPolicy: loadDispatchPolicy(env.DISPATCH_POLICY),
    modelProfiles: loadModelProfiles(env.MODEL_PROFILES),
    artifactConfig: loadArtifacts(env.ARTIFACT_STORE),
    artifactConfigs: z
      .array(z.object({ provider: z.string() }).passthrough())
      .max(30)
      .parse(JSON.parse(env.ARTIFACT_STORES || "[]"))
      .map((value) => loadArtifacts(JSON.stringify(value))!),
    artifactRetentionDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(30)
      .parse(env.ARTIFACT_RETENTION_DAYS),
    connections: loadConnections(env.CONNECTIONS),
    secrets: environmentSecrets({
      json: env.CONNECTION_CREDENTIALS,
      file: env.CONNECTION_CREDENTIALS_FILE,
    }),
    channels: loadChannels(env.CHANNEL_ACCOUNTS),
    mail: loadMailConfig(env),
    mailAccounts: loadMailAccounts(env),
    mailCredentials: createMailCredentials(env),
  };
}

/** 无配置时不增加配额；公平领取始终开启，变更上限不改变既有任务检查点。 */
export function loadDispatchPolicy(raw: string | undefined): DispatchPolicy {
  const limit = z.number().int().min(1).max(10000);
  try {
    return z
      .object({
        queueLimit: limit.optional(),
        workspaceConcurrency: limit.optional(),
        workspaces: z.record(z.string(), limit).optional(),
        modules: z.record(z.string(), limit).optional(),
      })
      .strict()
      .parse(JSON.parse(raw || "{}"));
  } catch {
    throw new Error("DISPATCH_CONFIG_INVALID");
  }
}
