import { FileDownloads } from "../packages/artifacts/downloads.js";
import { Memories } from "../packages/context/memory.js";
import { TaskGroups } from "../packages/persistence/groups.js";
import { OidcIdentityProvider } from "../adapters/identity/oidc.js";
import { PrincipalTokens } from "../packages/identity/tokens.js";
import { Delegations } from "../packages/identity/delegation.js";
import { otlpTelemetry } from "../packages/observability/tracing.js";
import { WorkspaceCosts } from "../packages/observability/costs.js";
import {
  LocalIdentityProvider,
  TokenIdentityProvider,
  type IdentityProvider,
} from "../packages/identity/provider.js";
import { createBusinessPorts } from "./business-ports.js";
import { BusinessJobs } from "../packages/persistence/business.js";
import {
  BusinessApplications,
  type PortBinding,
} from "../packages/business/application.js";
import {
  ContextManager,
  type ContextProvider,
} from "../packages/context/index.js";
import { businessPackages } from "../modules/packages.js";
import { assembleBusiness } from "./business.js";
import type { BusinessPackage } from "../packages/business/index.js";
/** 唯一装配入口：核心不导入业务，替换业务只修改注册及适配器配置。 */
import { integrationExamples } from "../modules/examples/index.js";
import { assembleMail } from "./mail-assembly.js";
import { admitConnection } from "../packages/runtime/admission.js";
import { createModelProfiles } from "./models.js";
import {
  ModelProfiles,
  type ModelProfile,
} from "../packages/runtime/models.js";
import {
  ArtifactFiles,
  type ArtifactStore,
} from "../packages/artifacts/index.js";
import { artifactProviders } from "./artifacts.js";
import { Connections } from "../packages/connections/index.js";

import { assembleChannels, type ChannelExtension } from "./channel-assembly.js";
import { Resources } from "../packages/extensions/registry.js";
import { Database } from "../packages/persistence/database.js";
import { TaskStore } from "../packages/persistence/tasks.js";
import { ReconciliationStore } from "../packages/persistence/reconciliation.js";
import { ExecutionStore } from "../packages/persistence/execution.js";
import { WaitStore } from "../packages/persistence/waits.js";
import { SignalStore } from "../packages/persistence/signals.js";
import { ScheduleStore } from "../packages/persistence/schedules.js";
import { IdentityService } from "../packages/identity/service.js";
import { AdministrationService } from "../packages/identity/administration.js";
import { Registry } from "../packages/runtime/registry.js";
import { Worker } from "../packages/runtime/worker.js";
import { ToolBroker } from "../packages/tool-execution/broker.js";
import { BusinessRequestService } from "./business-requests.js";
import { Deployments } from "../packages/deployment/index.js";
import { configuredResources } from "./resource-inventory.js";
import { TaskService } from "../packages/runtime/service.js";
import { Operations } from "../packages/observability/service.js";
import { DemoEngine, PiEngine } from "../adapters/engine-pi/index.js";
import type { Module, ModelEngine } from "../packages/contracts/index.js";
import { defaultModuleVersions } from "../modules/catalog.js";
import { createModules, registeredCapabilities } from "./modules.js";
import { MailHub } from "../packages/mail/hub.js";
import type {
  MailSettings,
  MailProvider,
  MailRouter,
} from "../packages/mail/contracts.js";
import type { Config } from "./config.js";
/** extensions 可替换模块和模型实现；资源由调用方创建并负责关闭，版本变化须同步更新 profile。 */
export interface ContainerExtensions {
  identityProvider?: IdentityProvider;
  modules?: Module[];
  ports?: Record<string, PortBinding>;
  artifactStores?: ArtifactStore[];
  contexts?: ContextProvider[];
  businesses?: BusinessPackage[];
  channels?: ChannelExtension[];
  modelProfiles?: ModelProfile[];
  artifactStore?: ArtifactStore;
  engine?: ModelEngine;
  profile?: string;
  defaults?: Record<string, string>;
  mails?: {
    settings: MailSettings;
    provider: MailProvider;
    route?: MailRouter;
  }[];
  mail?: { settings: MailSettings; provider: MailProvider; route?: MailRouter };
}
export async function createContainer(
  config: Config,
  extensions: ContainerExtensions = {},
) {
  const db = new Database(config.DATABASE_URL);
  const resources = new Resources();
  resources.add(() => db.close());
  try {
    return await assemble(config, extensions, db, resources);
  } catch (error) {
    // 保留原启动错误；close 已尽力释放全部资源，不让清理错误掩盖根因。
    await resources.close().catch(() => {});
    throw error;
  }
}
async function assemble(
  config: Config,
  extensions: ContainerExtensions,
  db: Database,
  resources: Resources,
) {
  const resourceInventory = configuredResources(config, extensions);
  const engine = createEngine(config, extensions);
  const identity = new IdentityService(db);
  const telemetry = otlpTelemetry(config.telemetryEndpoint);
  resources.add(() => telemetry.close());
  const costs = new WorkspaceCosts(db, config.costPolicy);
  const secrets =
    config.secrets ??
    (async () => {
      throw new Error("CREDENTIAL_UNAVAILABLE");
    });
  const connections = new Connections(
    config.connections ?? [],
    secrets,
    (workspace, id) => identity.current(workspace, id),
    (id, limit) => admitConnection(db, id, limit),
    telemetry,
  );
  const models = new ModelProfiles(
    engine,
    extensions.modelProfiles ??
      (await createModelProfiles(
        config.modelProfiles ?? [],
        connections,
        resources,
      )),
  );
  const memories = new Memories(db);
  const contexts = createContexts(db, extensions, config, memories);
  const registry = new Registry(
    JSON.stringify({
      extensions: extensions.profile ?? "default",
      engine: engine.id,
      model: config.LLM_MODEL,
      modelUrl: config.LLM_BASE_URL,
      inputPrice: config.LLM_INPUT_PRICE,
      outputPrice: config.LLM_OUTPUT_PRICE,
      modelOptions: config.modelOptions,
    }),
    models.fingerprints(),
    contexts.fingerprints(),
  );
  resources.add(() => registry.executionHost.close());
  for (const module of extensions.modules ?? createModules())
    registry.register(module);
  for (const [id, version] of Object.entries(
    extensions.defaults ?? (extensions.modules ? {} : defaultModuleVersions),
  ))
    registry.setDefault(id, version);
  const tasks = new TaskStore(
    db,
    registry,
    config.managedDeployment,
    telemetry,
    config.dispatchPolicy?.queueLimit,
  );
  const execution = new ExecutionStore(
    db,
    registry,
    30_000,
    config.dispatchPolicy,
    config.workerPool,
    config.workerLabels,
  );
  const waits = new WaitStore(execution);
  const groups = new TaskGroups(tasks, execution, registry);
  const signals = new SignalStore(db);
  const reconciliation = new ReconciliationStore(db, registry);

  const service = new TaskService(
    tasks,
    registry,
    identity,
    waits,
    signals,
    contexts,
    new Delegations(db),
    reconciliation,
  );
  const files = await assembleFiles(
    config,
    extensions,
    resources,
    db,
    service,
    secrets,
  );
  if (!extensions.modules && config.EXAMPLES_ENABLED === "true")
    for (const module of integrationExamples({ files, connections }))
      registry.register(module);
  const stores = await collectStores(
    config,
    extensions,
    db,
    service,
    resources,
    secrets,
    files,
  );
  const applications = new BusinessApplications();
  const permissions = await assembleBusiness(
    extensions.businesses ?? businessPackages,
    config.businesses ?? [],
    {
      connections,
      files,
      stores,
      ports: extensions.ports ?? createBusinessPorts(),
      applications,
      models,
      contexts: contexts.fingerprints(),
      channels: channelBindings(config, extensions),
    },
    registry,
    resources,
  );
  const channels = await assembleChannels(
    config,
    extensions.channels,
    db,
    identity,
    service,
    resources,
  );
  const mails = await assembleMail(
    config,
    extensions,
    db,
    identity,
    service,
    resources,
  );
  const mail = mails.length === 1 ? mails[0] : undefined;
  return {
    close: () => resources.close(),
    telemetry,
    costs,
    memories,
    groups,
    stores,
    downloads: new FileDownloads(db, stores),
    applications,
    businessRequests: new BusinessRequestService(db, identity),
    deployments: new Deployments(db),
    admission: (id: string, limit: number) => admitConnection(db, id, limit),
    resourceInventory,
    businessJobs: new BusinessJobs(
      db,
      tasks,
      applications,
      config.businesses ?? [],
    ),
    files,
    models,
    contexts,
    channels,
    connections,
    mail,
    mails,
    mailHub: new MailHub(mails),
    config,
    db,
    registry,
    tasks,
    execution,
    waits,
    identity,
    tokens: new PrincipalTokens(db),
    delegations: new Delegations(db),
    identityProvider: authentication(config, extensions, identity),
    administration: new AdministrationService(db, identity, () => [
      ...new Set([...registeredCapabilities(registry.list()), ...permissions]),
    ]),
    engine,
    service,
    signals,
    schedules: new ScheduleStore(tasks, registry),
    operations: new Operations(
      db,
      registry,
      config.workerPool,
      config.workerLabels,
    ),
    worker: new Worker(
      execution,
      waits,
      identity,
      registry,
      engine,
      models,
      contexts,
      telemetry,
      costs,
      groups,
      async (task) => {
        for (const child of await tasks.children(task.id))
          await service.authorize(
            await identity.current(task.workspace_id, task.principal_id),
            child,
          );
      },
      new ToolBroker(),
    ),
  };
}
async function assembleFiles(
  config: Config,
  extensions: ContainerExtensions,
  resources: Resources,
  db: Database,
  service: TaskService,
  secrets: import("../packages/connections/index.js").SecretProvider,
) {
  const artifactStore =
    extensions.artifactStore ??
    (config.artifactConfig
      ? await artifactProviders.create(
          config.artifactConfig.provider,
          config.artifactConfig,
          secrets,
        )
      : undefined);
  if (!extensions.artifactStore && artifactStore?.close)
    resources.add(() => artifactStore.close!());
  const files = artifactStore
    ? new ArtifactFiles(
        db,
        service,
        artifactStore,
        config.artifactRetentionDays,
      )
    : undefined;
  return files;
}
export type Container = Awaited<ReturnType<typeof createContainer>>;

function channelBindings(config: Config, extensions: ContainerExtensions) {
  const entries =
    extensions.channels?.map((c) => c.settings) ?? config.channels ?? [];
  return Object.fromEntries(entries.map((c) => [c.id, JSON.stringify(c)]));
}

async function collectStores(
  config: Config,
  extensions: ContainerExtensions,
  db: Database,
  service: TaskService,
  resources: Resources,
  secrets: import("../packages/connections/index.js").SecretProvider,
  files?: ArtifactFiles,
) {
  const stores = new Map<string, ArtifactFiles>();
  if (files) stores.set(files.store.id, files);
  const configured: ArtifactStore[] = [];
  for (const definition of config.artifactConfigs ?? []) {
    const store = await artifactProviders.create(
      definition.provider,
      definition,
      secrets,
    );
    if (store.close) resources.add(() => store.close!());
    configured.push(store);
  }
  for (const store of [...configured, ...(extensions.artifactStores ?? [])]) {
    if (stores.has(store.id)) throw new Error("ARTIFACT_STORE_DUPLICATE");
    stores.set(
      store.id,
      new ArtifactFiles(db, service, store, config.artifactRetentionDays),
    );
  }

  return stores;
}

function authentication(
  config: Config,
  extensions: ContainerExtensions,
  identity: IdentityService,
) {
  if (extensions.identityProvider) return extensions.identityProvider;
  if (config.oidc) {
    if (config.AUTH_MODE !== "token")
      throw new Error("OIDC_REQUIRES_TOKEN_MODE");
    return new OidcIdentityProvider(config.oidc);
  }
  const token = new TokenIdentityProvider(identity);
  return {
    get id() {
      return config.AUTH_MODE === "none" ? "local" : "token";
    },
    authenticate(authorization: string | undefined) {
      return config.AUTH_MODE === "none"
        ? new LocalIdentityProvider({
            workspace: config.LOCAL_WORKSPACE,
            principal: config.LOCAL_PRINCIPAL,
          }).authenticate()
        : token.authenticate(authorization);
    },
  };
}

function createEngine(config: Config, extensions: ContainerExtensions) {
  const engine =
    extensions.engine ??
    (config.MODEL_MODE === "demo"
      ? new DemoEngine()
      : new PiEngine({
          baseUrl: config.LLM_BASE_URL,
          apiKey: config.LLM_API_KEY!,
          model: config.LLM_MODEL,
          inputPrice: config.LLM_INPUT_PRICE,
          outputPrice: config.LLM_OUTPUT_PRICE,
          ...config.modelOptions,
          reasoning: config.modelOptions?.reasoningLevels?.some(
            (v) => v !== "none",
          ),
        }));
  return engine;
}

function createContexts(
  db: Database,
  extensions: ContainerExtensions,
  config: Config,
  memories: Memories,
) {
  return new ContextManager(db, [
    ...(extensions.contexts ?? []),
    ...(config.memoryEnabled ? [memories.provider()] : []),
  ]);
}
