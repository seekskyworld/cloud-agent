// 生成可编译的扩展骨架；默认拒绝外部操作，维护者实现协议后再注册到生产清单。
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const [kind, id] = process.argv.slice(2);
if (
  !["mail", "channel"].includes(kind) ||
  !id ||
  !/^[a-z][a-z0-9-]{0,63}$/.test(id)
)
  throw new Error("Usage: pnpm extension:create mail|channel <id>");
const directory = resolve("adapters", id);
await mkdir(directory);
try {
  const content =
    kind === "mail"
      ? `/** ${id} 协议适配；实现真实认证与错误映射后在 apps/extensions.ts 注册。 */
import { defineExtension } from "../../packages/extensions/registry.js";
import { CommonAccount,type MailAdapter,type MailContext } from "../mail/settings.js";
import { z } from "zod";
const Schema=CommonAccount.extend({provider:z.literal(${JSON.stringify(id)})}).strict();
export const extension=defineExtension<MailAdapter,MailContext,typeof Schema>({id:${JSON.stringify(id)},schema:Schema,capabilities:["receive","send"],identity:config=>({key:JSON.stringify([config.provider,config.address])}),create(config){
  const unavailable=async():Promise<never>=>{throw new Error("CONNECTOR_NOT_CONFIGURED");};
  return {remoteId:config.address,physical:config.address,identity:[config.provider,config.address],provider:{list:unavailable,read:unavailable,send:unavailable}};
}});
`
      : `/** ${id} 通道适配；verify 先验签，再映射可信 subject。 */
import { z } from "zod";
import { defineExtension } from "../../packages/extensions/registry.js";
import type { SecretProvider } from "../../packages/connections/index.js";
import type { ChannelProvider } from "../../packages/channels/channel.js";
const Schema=z.object({provider:z.literal(${JSON.stringify(id)}),id:z.string(),workspace:z.string(),bindings:z.record(z.string(),z.string()),moduleId:z.string(),sendEnabled:z.boolean()}).strict();
export const extension=defineExtension<ChannelProvider,SecretProvider,typeof Schema>({id:${JSON.stringify(id)},schema:Schema,capabilities:["verify","send"],identity:config=>({key:config.id}),create(){
  const unavailable=async():Promise<never>=>{throw new Error("CONNECTOR_NOT_CONFIGURED");};
  return {verify:unavailable,send:unavailable};
}});
`;
  await writeFile(resolve(directory, "index.ts"), content, { flag: "wx" });
  await writeFile(
    resolve(directory, "README.md"),
    `# ${id}\n\n此骨架默认拒绝调用。实现协议后，用 tests/extension-contracts.ts 的契约帮助函数测试；注册和注入方法见 docs/extending.md。\n`,
    { flag: "wx" },
  );
  process.stdout.write(
    `Created adapters/${id}; implement and validate before registration.\n`,
  );
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
