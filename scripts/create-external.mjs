/** 在独立目录生成公开 SDK 消费者；不修改宿主清单，不覆盖已有目录。 */
import { mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { resolve } from "node:path";
const [kind, id, destination, sdk] = process.argv.slice(2);
if (
  !["business", "mail"].includes(kind) ||
  !id ||
  !/^[a-z][a-z0-9-]{0,49}$/.test(id) ||
  !destination ||
  !sdk
)
  throw Error(
    "Usage: external:create business|mail <id> <directory> <sdk.tgz>",
  );
const artifact = resolve(sdk),
  directory = resolve(destination);
await access(artifact);
const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
await mkdir(directory);
try {
  const source =
    kind === "business"
      ? `import {z} from 'zod';
import {defineBusinessPackage} from '@cloud-agent/sdk';
export const extension=defineBusinessPackage({id:'${id}',version:'1.0.0',sdkMajor:1,permissions:['${id}:run'],requires:{},config:z.object({}),create:()=>({modules:[{id:'${id}',version:'1.0.0',title:'${id}',description:'Independent package',capability:'${id}:run',input:z.object({text:z.string()}),example:{text:'hello'},runtime:{model:false},tools:[],next:input=>({kind:'complete',result:input})}]})});
`
      : `import {z} from 'zod';
import {CommonAccount,defineExtension,type MailAdapter,type MailContext} from '@cloud-agent/sdk/connectors';
const schema=CommonAccount.extend({provider:z.literal('${id}')});
export const extension=defineExtension<MailAdapter,MailContext,typeof schema>({id:'${id}',schema,capabilities:['send'],create:config=>({remoteId:config.address,physical:config.address,identity:[config.provider,config.address],provider:{mode:'send',send:async()=>{throw Error('CONNECTOR_NOT_CONFIGURED');}}})});
`;
  await writeFile(resolve(directory, "index.ts"), source);
  await writeFile(
    resolve(directory, "contract.test.ts"),
    `import test from 'node:test'; import assert from 'node:assert/strict'; import {extension} from './index.js'; test('public manifest',()=>assert.equal(extension.id,'${id}'));\n`,
  );
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify(
      {
        name: id,
        version: "1.0.0",
        private: true,
        type: "module",
        exports: "./dist/index.js",
        types: "./dist/index.d.ts",
        scripts: {
          build: "tsc",
          test: "npm run build && node --test dist/contract.test.js",
        },
        dependencies: {
          "@cloud-agent/sdk": `file:${artifact}`,
          zod: root.dependencies.zod,
        },
        devDependencies: {
          typescript: root.devDependencies.typescript,
          "@types/node": root.devDependencies["@types/node"],
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    resolve(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2023",
          module: "NodeNext",
          declaration: true,
          outDir: "dist",
          skipLibCheck: false,
        },
        include: ["*.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    resolve(directory, "README.md"),
    `# ${id}\n\n运行 npm install 和 npm test。SDK 依赖指向调用方提供的本地制品；分发前替换为团队维护的制品来源。\n\n${kind === "business" ? "宿主静态导入 extension，配置业务绑定并显式授予能力。" : "此仅发送连接器默认拒绝实际发送；实现供应商协议、明确错误与未知结果语义后，注册到宿主的邮件供应商清单。使用 @cloud-agent/sdk/testing 的契约帮助函数并完成真实隔离协议测试。"}\n`,
  );
  process.stdout.write(`Created independent ${kind} package at ${directory}\n`);
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
