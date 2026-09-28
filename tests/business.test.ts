import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createApp } from "../apps/api/app.js";
import { join, resolve } from "node:path";
import { execFile as exec } from "node:child_process";
import { promisify } from "node:util";
import {
  defineBusinessPackage,
  loadBusinessDeployments,
  resolveBusiness,
} from "../packages/business/index.js";
import { assembleBusiness } from "../apps/business.js";
import {
  Resources,
  ExtensionRegistry,
  defineExtension,
} from "../packages/extensions/registry.js";
import { Connections } from "../packages/connections/index.js";
import { ModelProfiles } from "../packages/runtime/models.js";
import { Registry } from "../packages/runtime/registry.js";
import { DemoEngine } from "../adapters/engine-pi/index.js";
import { createContainer } from "../apps/container.js";
import { diagnose } from "../apps/doctor.js";
import { starterPackage } from "../modules/starter-package/index.js";
import { setup, principal, drain, token, otherToken } from "./helpers.js";
const execFile = promisify(exec);
const bare = defineBusinessPackage({
  id: "fixture",
  version: "1.0.0",
  sdkMajor: 1,
  permissions: ["report:run"],
  config: z.object({}).strict(),
  requires: {},
  create: () => ({ modules: [] }),
});
const host = {
  connections: new Connections(
    [],
    async () => ({}),
    async () => principal,
  ),
  models: new ModelProfiles(new DemoEngine()),
  channels: {},
};
test("业务清单拒绝错误 SDK、配置、依赖；生命周期和权限声明完整", async () => {
  assert.throws(
    () => defineBusinessPackage({ ...bare, sdkMajor: 2 }),
    /SDK_INCOMPATIBLE/,
  );
  assert.throws(
    () => defineBusinessPackage({ ...bare, id: "../bad" }),
    /ID_INVALID/,
  );
  assert.throws(
    () => loadBusinessDeployments('[{"id":"x"},{"id":"x"}]'),
    /CONFIG_INVALID/,
  );
  const deployment = loadBusinessDeployments('[{"id":"fixture"}]')[0]!;
  assert.throws(
    () =>
      resolveBusiness(
        { ...bare, requires: { db: { kind: "connection" } } },
        deployment,
      ),
    /BINDING_REQUIRED/,
  );
  assert.throws(
    () => resolveBusiness(bare, { ...deployment, bindings: { x: "y" } }),
    /BINDING_UNKNOWN/,
  );
  assert.throws(
    () => resolveBusiness(bare, { ...deployment, config: { unknown: true } }),
    /CONFIG_INVALID/,
  );
  const registry = new Registry(),
    resources = new Resources();
  await assert.rejects(
    assembleBusiness([bare, bare], [], host, registry, resources),
    /BUSINESS_DUPLICATE/,
  );
  await assert.rejects(
    assembleBusiness([], [deployment], host, registry, resources),
    /NOT_REGISTERED/,
  );
  await assert.rejects(
    assembleBusiness(
      [{ ...bare, requires: { db: { kind: "connection" } } }],
      [{ ...deployment, bindings: { db: "missing" } }],
      host,
      registry,
      resources,
    ),
    /DEPENDENCY_MISSING/,
  );
  let closed = 0;
  const c = await setup();
  try {
    const module = c.registry.get("report");
    await assert.rejects(
      assembleBusiness(
        [
          {
            ...bare,
            permissions: [],
            create: () => ({
              modules: [module],
              close: async () => {
                closed++;
              },
            }),
          },
        ],
        [deployment],
        host,
        registry,
        resources,
      ),
      /PERMISSION_UNDECLARED/,
    );
    await resources.close();
    assert.equal(closed, 1);
    await assert.rejects(
      assembleBusiness(
        [
          {
            ...bare,
            create: () => ({ modules: [{ ...module, runtime: undefined }] }),
          },
        ],
        [deployment],
        host,
        registry,
        new Resources(),
      ),
      /RUNTIME_REQUIRED/,
    );
  } finally {
    await c.close();
  }
});
test("第三方扩展自行声明诊断和依赖，未实现诊断不假报成功", async () => {
  const schema = z.object({ connection: z.string() });
  const registry = new ExtensionRegistry([
    defineExtension({
      id: "custom",
      capabilities: [],
      schema,
      references: (c) => [{ kind: "connection", id: c.connection }],
      diagnose: async () => {},
      create: () => ({}),
    }),
    defineExtension({
      id: "unchecked",
      capabilities: [],
      schema,
      create: () => ({}),
    }),
    defineExtension({
      id: "failed",
      capabilities: [],
      schema,
      diagnose: async () => {
        throw new Error("secret-value");
      },
      create: () => ({}),
    }),
  ]);
  assert.deepEqual(registry.references("custom", { connection: "a" }), [
    { kind: "connection", id: "a" },
  ]);
  assert.equal(
    (await registry.diagnose("custom", { connection: "a" }, undefined)).status,
    "passed",
  );
  assert.equal(
    (await registry.diagnose("unchecked", { connection: "a" }, undefined))
      .status,
    "unchecked",
  );
  const failure = await registry.diagnose(
    "failed",
    { connection: "a" },
    undefined,
  );
  assert.equal(failure.ok, false);
  assert.ok(!JSON.stringify(failure).includes("secret-value"));
  assert.equal(
    (await registry.diagnose("custom", {}, undefined)).status,
    "failed",
  );
});
test("starter 业务包绑定文件存储后经真实 Worker 生成文件；配置变化隔离旧任务", async () => {
  const base = await setup(),
    directory = await mkdtemp(join(tmpdir(), "cloud-agent-business-"));
  const config = {
    ...base.config,
    artifactConfig: { provider: "local", id: "reports", directory },
    businesses: loadBusinessDeployments(
      '[{"id":"starter","bindings":{"output":"reports"}}]',
    ),
  };
  const c = await createContainer(config);
  try {
    await c.db.pool.query(
      "UPDATE principals SET capabilities=array_append(capabilities,'starter:run') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    const actor = await c.identity.current(
      principal.workspace_id,
      principal.id,
    );
    const task = await c.service.create(
      actor,
      "starter-report",
      { text: "hello" },
      "starter",
    );
    await drain(c);
    const detail = await c.service.detail(actor, task.id);
    assert.equal(detail.task.status, "succeeded");
    assert.equal(detail.files.length, 1);
    assert.match(
      (await c.files!.get(actor, detail.files[0].id)).data.toString(),
      /hello/,
    );
    const changed = await createContainer({
      ...config,
      businesses: [{ ...config.businesses[0]!, config: { prefix: "changed" } }],
    });
    try {
      assert.equal(changed.registry.accepts(task), false);
    } finally {
      await changed.close();
    }
    const doctor = await diagnose(config);
    assert.equal(doctor.ok, true);
    assert.equal(
      (await diagnose({ ...config, artifactConfig: undefined })).ok,
      false,
    );
    assert.equal(starterPackage.sdkMajor, 1);
  } finally {
    await c.close();
    await base.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("生成业务包通过公共 SDK 独立编译和运行，重复生成不覆盖", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-agent-scaffold-"));
  try {
    await mkdir(join(directory, "modules"));
    await writeFile(
      join(directory, "modules/packages.ts"),
      "export const businessPackages = [\n// generated:packages\n];\n",
    );
    await mkdir(join(directory, "node_modules"));
    await symlink(resolve("."), join(directory, "node_modules/cloud-agent"));
    await symlink(
      resolve("node_modules/zod"),
      join(directory, "node_modules/zod"),
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await execFile(
      process.execPath,
      [resolve("scripts/create-package.mjs"), "sample"],
      { cwd: directory },
    );
    const before = await readFile(
      join(directory, "modules/sample-package/index.ts"),
      "utf8",
    );
    await assert.rejects(
      execFile(
        process.execPath,
        [resolve("scripts/create-package.mjs"), "sample"],
        { cwd: directory },
      ),
    );
    assert.equal(
      await readFile(
        join(directory, "modules/sample-package/index.ts"),
        "utf8",
      ),
      before,
    );
    await execFile(
      resolve("node_modules/.bin/tsx"),
      [
        "--conditions=development",
        "--test",
        "modules/sample-package/contract.test.ts",
      ],
      { cwd: directory },
    );
    await writeFile(
      join(directory, "verify.ts"),
      `import {samplePackage} from './modules/sample-package/index.js'; const instance=await samplePackage.create({},{} as never); const result=instance.modules[0]!.next({text:'world'},[]); if(result.kind!=='complete'||JSON.stringify(result.result)!=='{"text":"Hello world"}') throw Error('BAD_RESULT');`,
    );
    await execFile(
      resolve("node_modules/.bin/tsx"),
      ["--conditions=development", "verify.ts"],
      { cwd: directory },
    );
    await execFile(
      resolve("node_modules/.bin/tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "verify.ts",
      ],
      { cwd: directory },
    );
    await verifyGeneratedPackage(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("模块只绑定声明消费的配置，无关依赖变化不阻断旧任务", async () => {
  const manifest = defineBusinessPackage({
    ...bare,
    config: z.object({ used: z.string(), unrelated: z.string() }),
    requires: { primary: { kind: "channel" }, secondary: { kind: "channel" } },
    create: () => ({
      modules: [
        {
          id: "selective",
          version: "1",
          title: "fixture",
          description: "fixture",
          capability: "report:run",
          input: z.object({}),
          example: {},
          tools: [],
          runtime: { model: false },
          next: () => ({ kind: "complete", result: null }),
        },
      ],
      dependencies: { selective: { bindings: ["primary"], config: ["used"] } },
    }),
  });
  async function build(used: string, unrelated: string, secondary: string) {
    const registry = new Registry(),
      resources = new Resources();
    await assembleBusiness(
      [manifest],
      loadBusinessDeployments(
        JSON.stringify([
          {
            id: "fixture",
            config: { used, unrelated },
            bindings: { primary: "one", secondary: "two" },
          },
        ]),
      ),
      { ...host, channels: { one: "stable", two: secondary } },
      registry,
      resources,
    );
    await resources.close();
    return registry;
  }
  const first = await build("a", "x", "v1"),
    unrelated = await build("a", "y", "v2"),
    changed = await build("b", "y", "v2");
  assert.equal(
    first.hash(first.get("selective")),
    unrelated.hash(unrelated.get("selective")),
  );
  assert.notEqual(
    first.hash(first.get("selective")),
    changed.hash(changed.get("selective")),
  );
  assert.notDeepEqual(
    first.deployment().businesses,
    unrelated.deployment().businesses,
  );
});

/** 教程生成物必须能经过真实 API/Worker，而不只通过清单编译。 */
async function verifyGeneratedPackage(directory: string) {
  const { samplePackage } = (await import(
    pathToFileURL(join(directory, "modules/sample-package/index.ts")).href
  )) as { samplePackage: typeof bare };
  const base = await setup();
  const container = await createContainer(
    {
      ...base.config,
      businesses: loadBusinessDeployments(
        '[{"id":"sample","config":{"prefix":"Hello"},"bindings":{}}]',
      ),
    },
    { businesses: [samplePackage] },
  );
  const app = await createApp(container);
  try {
    const request = {
      method: "POST" as const,
      url: "/v1/tasks",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "tutorial-1",
      },
      payload: { moduleId: "sample", input: { text: "world" } },
    };
    assert.equal((await app.inject(request)).statusCode, 403);
    await container.db.pool.query(
      "UPDATE principals SET capabilities=array_append(capabilities,'sample:run') WHERE workspace_id=$1",
      [principal.workspace_id],
    );
    const response = await app.inject(request);
    assert.equal(response.statusCode, 202, response.body);
    const task = response.json();
    assert.equal((await app.inject(request)).json().id, task.id);
    await drain(container);
    const detail = (
      await app.inject({
        url: `/v1/tasks/${task.id}`,
        headers: request.headers,
      })
    ).json();
    assert.equal(detail.task.status, "succeeded");
    assert.deepEqual(detail.task.result, { text: "Hello world" });
    assert.equal(
      (
        await app.inject({
          url: `/v1/tasks/${task.id}`,
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await container.close();
    await base.close();
  }
}
