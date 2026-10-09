/** 中立契约夹具：仅用版本化字符串记录验证迁移、端口、路由、作业与页面声明。 */
import { z } from "zod";
import {
  defineBusinessPackage,
  definePort,
  type Principal,
} from "cloud-agent/sdk";
const RecordValue = z.object({
  id: z.string(),
  value: z.string(),
  version: z.number().int(),
});
export type RecordValue = z.infer<typeof RecordValue>;
export const RecordCommand = z
  .object({
    id: z.string(),
    value: z.string(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export interface Records {
  list(actor: Principal): Promise<RecordValue[]>;
  write(
    actor: Principal,
    input: z.infer<typeof RecordCommand>,
    key: string,
  ): Promise<RecordValue>;
}
export const recordsPort = definePort<Records>(
  "fixture.records",
  1,
  (value): value is Records =>
    Boolean(
      value &&
      typeof value === "object" &&
      "list" in value &&
      typeof value.list === "function" &&
      "write" in value &&
      typeof value.write === "function",
    ),
);
export const recordsPackage = defineBusinessPackage({
  id: "fixture-records",
  version: "1.0.0",
  sdkMajor: 1,
  permissions: ["fixture:read", "fixture:write"],
  config: z.object({}).strict(),
  requires: {
    records: {
      kind: "port",
      protocol: { id: recordsPort.id, version: recordsPort.version },
    },
  },
  migrations: [
    {
      id: "001_records",
      sql: `
    CREATE TABLE records(workspace_id text NOT NULL,id text NOT NULL,value text NOT NULL,version integer NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE TABLE commands(workspace_id text NOT NULL,principal_id text NOT NULL,key text NOT NULL,hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(workspace_id,principal_id,key));
  `,
    },
  ],
  create(_config, services) {
    const records = services.port("records", recordsPort);
    return {
      pages: [{ id: "records", title: "测试记录", capability: "fixture:read" }],
      routes: [
        {
          id: "list",
          method: "GET",
          capability: "fixture:read",
          input: z.object({}).strict(),
          output: z.array(RecordValue),
          handle: (_input, ctx) => records.list(ctx.principal),
        },
        {
          id: "write",
          method: "POST",
          capability: "fixture:write",
          input: RecordCommand,
          output: RecordValue,
          handle: (input, ctx) =>
            records.write(ctx.principal, RecordCommand.parse(input), ctx.key!),
        },
      ],
      jobs: [
        {
          id: "snapshot",
          moduleId: "fixture-snapshot",
          input: {},
          intervalSeconds: 86400,
        },
      ],
      modules: [
        {
          id: "fixture-snapshot",
          version: "1.0.0",
          title: "端口读取测试",
          description: "读取记录验证作业调度",
          capability: "fixture:read",
          input: z.object({}).strict(),
          example: {},
          runtime: { model: false },
          tools: [
            {
              name: "fixture.list",
              version: "1",
              description: "读取测试记录",
              capability: "fixture:read",
              effect: "read",
              timeoutMs: 5000,
              input: z.object({}).strict(),
              output: z.array(RecordValue),
              execute: async (_input, ctx) => ({
                kind: "succeeded",
                output: await records.list(ctx.principal),
              }),
            },
          ],
          next: (_input, steps) =>
            steps.length
              ? {
                  kind: "complete",
                  result: {
                    total: z.array(RecordValue).parse(steps[0]!.output).length,
                  },
                }
              : {
                  kind: "tool",
                  key: "records",
                  name: "fixture.list",
                  input: {},
                },
        },
      ],
    };
  },
});
