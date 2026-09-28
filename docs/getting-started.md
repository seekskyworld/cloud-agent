# 从启动到接入第一个模块

本教程只用中立文本输入，不连接外部模型、邮箱或业务系统。需要 Node.js 24 LTS、pnpm 10.6.1、Docker Compose v2。源码入口是当前仓库；不要假设 SDK 已发布到 npm。

## 先跑一次任务

在仓库根目录执行：

```sh
node scripts/init-env.mjs
docker compose up -d --build --wait
```

已有 `.env` 时跳过初始化，脚本不会覆盖它。打开 <http://localhost:3100>，选择报告示例，创建任务、补充标题并下载结果。默认身份共享，仅用于本机体验。验收点：页面显示“已完成”，刷新后仍能读取任务。

也可以在独立终端通过 API 验证：

```sh
curl -fsS http://localhost:3100/v1/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: quickstart-report-1' \
  -d '{"moduleId":"report","input":{"title":"Hello","values":[1,2,3]}}'
```

记录响应中的任务 ID，通过 `GET /v1/tasks/<任务ID>` 查看状态和结果。同一身份、同一请求键及参数重复提交返回同一任务；变更参数时使用新的键。停止用 `docker compose stop`，保留已有数据卷。

## 创建自己的中立包

先按 [开发环境](development.md#本地热更新) 启动本地 API、Worker 和网页，避免改动现有部署。安装依赖后：

```sh
pnpm package:create greeting
pnpm exec tsx --conditions=development --test modules/greeting-package/contract.test.ts
```

生成器创建包源码、清单测试和说明，并注册到 `modules/packages.ts`。在开发 `.env` 中加入以下配置，然后重启 API 和 Worker：

```dotenv
BUSINESS_PACKAGES='[{"id":"greeting","config":{"prefix":"Hello"},"bindings":{}}]'
```

运行 `pnpm doctor` 检查配置。通过权限管理为已有身份显式添加 `greeting:run`；角色本身不会授予新业务能力。工作台选择 greeting，输入文本并创建任务；结果应带 `Hello` 前缀。默认配置关闭此包时，入口不再提供它，已有数据不会被删除。

增加外部动作时定义带 Schema、能力和 effect 的 Tool，使用 `context.idempotencyKey`；不要在 `next` 内做 IO。需要业务表、独立 API 或页面时，按 [包贡献协议](extending.md#完整应用与独立制品) 增加，并补隔离验证。

## 添加工具并验证重启恢复

在新建的 greeting 包内，将 `modules/greeting-package/index.ts` 替换为下面代码。编排变化升级到 1.1.0；演示只用于新任务，已有 1.0.0 任务应保留其模块注册直到执行完毕。

<!-- tutorial:tool-package -->
```ts
import { z } from "zod";
import { defineBusinessPackage, type Tool } from "cloud-agent/sdk";

export const greetingPackage = defineBusinessPackage({
  id: "greeting", version: "1.1.0", sdkMajor: 1,
  permissions: ["greeting:run"],
  config: z.object({ prefix: z.string().default("Hello") }).strict(),
  requires: {},
  create(config) {
    const render: Tool = {
      name: "greeting.render", version: "1",
      description: "确认参数后生成问候语，不调用外部系统",
      input: z.object({ text: z.string().min(1).max(2000) }).strict(),
      output: z.object({ text: z.string() }).strict(),
      capability: "greeting:run", effect: "read", approval: true,
      timeoutMs: 1000,
      async execute(input) {
        return { kind: "succeeded", output: { text: config.prefix + " " + input.text } };
      },
    };
    return { modules: [{
      id: "greeting", version: "1.1.0", title: "Greeting",
      description: "一个可恢复的工具步骤",
      capability: "greeting:run", input: render.input,
      example: { text: "Cloud Agent" }, tools: [render], runtime: { model: false },
      next(input, steps) {
        const rendered = steps.find((step) => step.key === "render");
        return rendered ? { kind: "complete", result: rendered.output } :
          { kind: "tool", key: "render", name: render.name, input };
      },
    }] };
  },
});
```

运行 `pnpm format && pnpm typecheck`，重启开发 API/Worker。沿用上面的 `BUSINESS_PACKAGES` 和 `greeting:run` 授权：

1. 工作台选择 Greeting，输入 `Cloud Agent`，提交后应停在“等待确认”。
2. 停止并重新启动开发 Worker（开发终端 Ctrl-C 后运行 `pnpm dev:worker`）；刷新网页，确认仍存在。
3. 确认参数，结果应为 `{"text":"Hello Cloud Agent"}`。再次重启 Worker，已完成任务和结果不改变。
4. 用相同 API 请求键和参数重放创建，仍返回原任务；不同主体不可确认此任务。

业务接入只改包的 `index.ts`、配置和权限，生成器修改宿主 `modules/packages.ts`，无需修改核心或新增任务 API。这里的 `read` 工具只是纯计算；替换为外部写入时必须改成正确的 effect，传递 `context.signal` 和 `context.idempotencyKey`，并实现远端幂等或结果查询。

教程代码由 `tests/tutorial.test.ts` 直接提取验证，包括首次未授权、等待后新 Worker 接管、拒绝审批、重复创建和完成后不重复执行。第二条组合接入路径参考 `tests/fixtures/pipeline-package.ts` 与 `tests/evolution-adapters.test.ts`：连接读取 → 模型 → 文件产物。这些是中立隔离验收，外部团队真实业务试用另见 [预览交付说明](preview-release.md)。

## 在独立工程中使用 SDK

从 Cloud Agent 源码构建：

```sh
pnpm install --frozen-lockfile
pnpm sdk:build
npm pack ./dist/sdk-package --pack-destination ./dist
pnpm sdk:verify
```

把生成的 `cloud-agent-sdk-0.3.0-preview.1.tgz` 交给独立工程，执行 `npm install <tarball路径>`，通过 `@cloud-agent/sdk`、`@cloud-agent/sdk/client` 或 `@cloud-agent/sdk/ui` 导入。直接导入 zod/React 时，由自己的包声明相应依赖。最小包代码见 [SDK README](../packages/sdk/README.md)。

源码内示例使用 `cloud-agent/sdk` 自引用；独立包使用 `@cloud-agent/sdk`。编译后由可信宿主静态导入导出清单，配置依赖绑定和权限；安装 SDK 本身不会启动 Agent。`pnpm sdk:verify` 使用全新目录真实安装 tarball、编译两个中立协议夹具及 UI 消费者，不链接宿主依赖。安装步骤需要 npm registry 网络。

## 如何验收改造

以 [开发验证](development.md#验证) 为准。接入方至少验证：首次执行、同键重放、跨身份拒绝、撤权、超时与未知结果、取消、重启恢复、模块升级兼容。外部写入未知时应核实原动作，不能直接重发。支持边界见 [支持矩阵](../SUPPORT.md)。
