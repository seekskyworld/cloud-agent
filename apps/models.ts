/** 模型实现静态注册；外部连接沿用共用授权/凭据端口，不把密钥存入任务指纹。 */
import { z } from "zod";
import {
  Resources,
  ExtensionRegistry,
  defineExtension,
} from "../packages/extensions/registry.js";
import { DemoEngine, PiEngine } from "../adapters/engine-pi/index.js";
import { bearer, type Connections } from "../packages/connections/index.js";
import { Problem, type ModelEngine } from "../packages/contracts/index.js";
import { fingerprint } from "../packages/persistence/database.js";
const Demo = z
  .object({ provider: z.literal("demo"), id: z.string().min(1) })
  .strict();
const Pi = z
  .object({
    provider: z.literal("pi"),
    id: z.string().min(1),
    connection: z.string().min(1),
    model: z.string().min(1),
    inputPrice: z.number().positive(),
    outputPrice: z.number().positive(),
    reasoning: z.boolean().default(false),
  })
  .strict();
export const modelProviders = new ExtensionRegistry<ModelEngine, Connections>([
  defineExtension<ModelEngine, Connections, typeof Demo>({
    id: "demo",
    capabilities: ["text"],
    schema: Demo,
    diagnose: async () => {},
    create: () => new DemoEngine(),
  }),
  defineExtension<ModelEngine, Connections, typeof Pi>({
    id: "pi",
    capabilities: ["text", "tools"],
    schema: Pi,
    references: (c) => [{ kind: "connection", id: c.connection }],
    diagnose: (c, connections, signal) =>
      connections.diagnose(c.connection, signal, bearer),
    create: (config, connections) => ({
      id: `pi:0.85.1:${config.id}`,
      capabilities: {
        structuredOutput: "validated",
        maxOutputTokens: 2048,
        reasoning: config.reasoning
          ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
          : ["none"],
        cache: true,
      },
      async next(request, tools, signal, context) {
        if (!context) throw new Problem(403, "MODEL_CONTEXT_REQUIRED");
        const connection = await connections.resolve(
          config.connection,
          context.principal,
          signal,
        );
        return new PiEngine({
          baseUrl: connection.endpoint,
          apiKey: bearer(connection.secret),
          model: config.model,
          inputPrice: config.inputPrice,
          outputPrice: config.outputPrice,
          reasoning: config.reasoning,
        }).next(request, tools, signal);
      },
    }),
  }),
]);
export function loadModelProfiles(raw: string | undefined) {
  try {
    const values = z
      .array(
        z
          .object({ id: z.string().min(1), provider: z.string().min(1) })
          .passthrough(),
      )
      .max(30)
      .parse(JSON.parse(raw || "[]"));
    if (new Set(values.map((p) => p.id)).size !== values.length)
      throw new Error("duplicate");
    for (const value of values) modelProviders.parse(value.provider, value);
    return values;
  } catch {
    throw new Error("MODEL_PROFILE_CONFIG_INVALID");
  }
}
export async function createModelProfiles(
  profiles: ReturnType<typeof loadModelProfiles>,
  connections: Connections,
  resources: Resources,
) {
  const entries = [];
  for (const config of profiles) {
    for (const reference of modelProviders.references(config.provider, config))
      if (
        reference.kind === "connection" &&
        !connections.definitions.some((c) => c.id === reference.id)
      )
        throw new Error("MODEL_CONNECTION_NOT_FOUND");
    const engine = await modelProviders.create(
      config.provider,
      config,
      connections,
    );
    if (engine.close) resources.add(() => engine.close!());
    entries.push({
      id: config.id,
      engine,
      fingerprint: fingerprint({
        engine: engine.id,
        config,
        connections: connections.definitions.filter((c) =>
          modelProviders
            .references(config.provider, config)
            .some((r) => r.kind === "connection" && r.id === c.id),
        ),
      }),
    });
  }
  return entries;
}
