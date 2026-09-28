// 业务包集中保存清单、测试和说明；注册只修改宿主静态清单，不触碰核心。
import { open, readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
const id = process.argv[2];
if (!id || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 50)
  throw new Error("Usage: pnpm package:create <id>");
const catalog = resolve("modules/packages.ts"),
  directory = resolve("modules", `${id}-package`),
  name = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()) + "Package";
const lock = await open(`${catalog}.lock`, "wx");
let created = false;
try {
  const previous = await readFile(catalog, "utf8");
  if (
    !previous.includes("// generated:packages") ||
    previous.includes(`{${name}}`) ||
    previous.includes(`{ ${name} }`)
  )
    throw new Error("BUSINESS_CATALOG_CONFLICT");
  await mkdir(directory);
  created = true;
  await writeFile(
    `${directory}/index.ts`,
    `/** ${id} 业务包：依赖公共 SDK，配置与权限由清单声明。 */
import {z} from "zod";
import {defineBusinessPackage} from "cloud-agent/sdk";
export const ${name}=defineBusinessPackage({id:${JSON.stringify(id)},version:"1.0.0",sdkMajor:1,permissions:[${JSON.stringify(id + ":run")}],config:z.object({prefix:z.string().default("Hello")}).strict(),requires:{},
 create(config){return {modules:[{id:${JSON.stringify(id)},version:"1.0.0",title:${JSON.stringify(id)},description:"独立业务包",capability:${JSON.stringify(id + ":run")},input:z.object({text:z.string().min(1)}).strict(),example:{text:"Cloud Agent"},tools:[],runtime:{model:false},next(input){return {kind:"complete",result:{text:config.prefix+" "+input.text}};}}]};}
});
`,
    { flag: "wx" },
  );
  await writeFile(
    `${directory}/contract.test.ts`,
    `/** 清单契约可在独立业务包 CI 中执行，集成测试仍应验证实际 Worker。 */
import test from "node:test";
import assert from "node:assert/strict";
import {${name}} from "./index.js";
test("business manifest",()=>{assert.equal(${name}.sdkMajor,1);assert.ok(${name}.config.safeParse({}).success);});
`,
    { flag: "wx" },
  );
  await writeFile(
    `${directory}/README.md`,
    `# ${id}\n\n通过 cloud-agent/sdk 的 v1 导出接入。部署设置 BUSINESS_PACKAGES='[{"id":"${id}","config":{},"bindings":{}}]'，已有身份显式授予 ${id}:run。\n\n用 pnpm exec tsx --conditions=development --test modules/${id}-package/contract.test.ts 验证包清单；修改 next 或工具语义时升级版本。前端可在同目录增加 views.tsx，由 modules/package-views.ts 静态导入。\n`,
    { flag: "wx" },
  );
  const next =
    `import {${name}} from "./${id}-package/index.js";\n` +
    previous.replace(
      "// generated:packages",
      `${name},\n  // generated:packages`,
    );
  await writeFile(`${catalog}.next`, next, { flag: "wx" });
  await rename(`${catalog}.next`, catalog);
  created = false;
  process.stdout.write(
    `Created modules/${id}-package; configure BUSINESS_PACKAGES and grant declared permissions.\n`,
  );
} finally {
  if (created) await rm(directory, { recursive: true, force: true });
  await lock.close();
  await rm(`${catalog}.lock`);
}
