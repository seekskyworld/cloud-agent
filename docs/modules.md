# 模块与适配器

业务写在 `modules/`，外部协议写在 `adapters/`，不修改 Worker。完整类型见 [contracts](../packages/contracts/index.ts)，流程参考 [报告模块](../modules/report-assistant/index.ts)。

## 最小模块

```sh
pnpm module:create echo
pnpm format
pnpm check
```

命令创建 `modules/echo/index.ts`，并静态注册到 [模块清单](../modules/catalog.ts)；已存在模块或并发清单编辑会拒绝，不覆盖源码。生成器给出可直接执行的回显模块。修改其 `input/example`、纯函数 `next` 和工具，然后重新构建 API 与 Worker；无需新路由。需要注入业务适配器时保留工厂，在 `apps/container.ts` 提供依赖。

新安装的初始身份自动获得注册能力；已有成员须在权限页授权，受保护超级管理员用 [可信配置命令](administration.md#可信配置) 设置完整能力集合。

## 编排与工具

`id/version` 标识模块及检查点兼容版本；`input/example` 定义输入 Schema 和有效示例；`capability/tools` 限定能力与可用工具；`budget` 控制累计消耗，retry 不重置预算。

`runtime: { model: false, config: {} }` 声明纯计算；调用模型必须设 `model: true`。会影响恢复的业务端点、策略版本等非秘密配置写入 `runtime.config`；凭据不进入配置摘要。未声明 `runtime` 的旧模块保守绑定完整运行配置，不能靠省略声明放宽恢复检查。`acceptLegacyProfile: true` 仅用于已验证编排与旧全局配置完全兼容的 0.2.0 模块；默认关闭，中立示例显式启用，生成模块不启用。新增依赖或改变语义时升级版本，不借此兼容标记跳过检查。

`next(input, steps)` 只根据输入与持久步骤决定动作，不访问网络、数据库、时钟或随机数：

| 动作       | 返回内容                                            |
| ---------- | --------------------------------------------------- |
| `tool`     | 稳定 key、工具名、参数                              |
| `model`    | 稳定 key、instructions/messages/tools，一次模型请求 |
| `wait`     | 稳定 key、输入 Schema、原因、有效期                 |
| `complete` | JSON 结果、可选标题                                 |

同一逻辑动作必须复用 key；循环按持久轮次和调用 ID 编号，按具体 key 判断步骤完成情况。

工具声明 `name/version/input/output/capability/effect/timeoutMs`，人工确认用 `approval: true`。`execute` 接收参数与可信 ExecutionContext：传递 `context.signal`，重试复用 `context.idempotencyKey`，凭据不写入参数、结果或模型上下文。返回 Outcome 区分成功、拒绝、失败、可重试和结果未知；断连不代表未执行。写入与对账规则见 [架构](cloud-agent-architecture.md#必须理解的执行语义)。

资源 ACL 由 `validateContext(steps, principal, signal)` 在继续执行前复核，`authorizeRead(task, principal, signal, steps)` 在完成及读取详情、产物、消息时复核。模块解释原始步骤中的资源标识和版本，核心不要求特定输出字段。

## 模型适配

[Pi 引擎](../adapters/engine-pi/index.ts) 使用 OpenAI-compatible Chat Completions，每轮最多输出 2048 token、上下文最多 80,000 字符；返回文本、工具建议与用量，不执行内部工具循环、不保存隐藏推理。启用方法见 [运维配置](operations.md#配置)。

自定义引擎实现 `ModelEngine.id` 和 `next(request, tools, signal): Promise<ModelTurn>`，返回非负成本，不能绕过平台执行工具。多轮流程由模块读取已保存结果、校验建议工具及参数、返回稳定 `tool` 动作，再将输出和原 call ID 放进下一轮消息。

长流程应将改写、提取、审核前处理和审核后构建拆成多个稳定 Step。提取阶段只返回元数据与原文行号范围，审核通过后再启动图谱或索引构建；模型请求声明 `checkpoint:{key,sourceDigest}` 后，平台会绑定任务配置、模型、提示词和请求参数指纹，租约恢复时复用完全一致的结果。`sourceDigest`、`ExtractedReference` 和 `restoreSourceRanges` 会拒绝摘要变化、非法行号、越界和重叠；全文提取使用 `restoreSourceRanges(source, digest, ranges, {coverage:"full"})` 检查遗漏，局部摘录默认允许间隔。输出换行统一为 LF。

## 外部 HTTP

[DomainHttp](../adapters/http/client.ts) 支持任意可信服务名，凭据按 workspace → principal → service 映射：

```ts
const credentials = {
  demo: { operator: { remote-api: "test-only-credential" } },
};
const client = new DomainHttp("remote-api", "https://service.example", credentials);
```

示例仅展示形状，实际凭据从服务端秘密存储注入。无对应用户凭据时拒绝，不回退共享管理员；地址不接受用户任意输入。

`request(path, context)` 使用 GET，提供 body 时使用 POST 并携带平台幂等键。远端须兑现幂等约定；客户端拒绝重定向，JSON 响应实际读取上限 1 MB。领域适配器校验状态与数据并映射 Outcome，不能将所有错误都视为可重试。非 Bearer/JSON、签名或文件协议使用独立适配器。

完整业务推荐 [业务包/SDK](extending.md#独立业务包与-sdk-v1)，生成器为 `pnpm package:create my-business`，避免把业务代码混在平台装配中。

## 装配与验证

模块可暴露 `createModule(port)` 工厂，在 `apps/container.ts` 注入适配器；不要直接读取进程环境。宿主也可替换整个集合：

```ts
const container = await createContainer(config, {
  modules: [myModule],
  engine: myEngine,
  profile: "my-app-v1",
  defaults: { "my-module": "2.0.0" },
});
```

参数由宿主提供：`modules` 为完整替换，`[]` 不加载示例；省略 engine 则按配置选择。宿主负责关闭外部资源，profile 标记模型或未声明依赖模块的运行配置；显式声明的纯计算模块只绑定自己的 `runtime.config`。初始化、API 与 Worker 必须共用清单。

清单的 `moduleFactories` 可同时包含同 ID 的多个版本，`defaultModuleVersions` 显式选择新任务版本；没有配置时选择首个注册版本，不依赖 semver 或导入顺序覆盖旧版。API 每个 ID 只展示一个默认版本；历史任务按自身版本执行和读取。Worker 领取前匹配指纹，不兼容任务继续排队；升级后的请求重放仍按原任务版本校验。保留历史版本直到对应任务和定时器处理完毕。

## 失败与恢复

适配器可从 `cloud-agent/sdk` 导入 `ExecutionFailure`，使用 permanent/authorization/transient/rate_limited/unknown 分类与安全大写 code。只读工具和模型遇到永久/权限错误终止，临时故障按预算退避；429 可带 `retryAfterMs`，平台不把供应商等待缩短到一分钟。`Problem` 的 4xx（429 除外）在只读执行中也视为不可自动重试。

写入异常默认保持 unknown；只有适配器确有证据证明未被接收时才用 `{notAccepted:true}` 允许按分类处理，不能仅凭一般 HTTP 5xx 或超时断言未执行。`DomainHttp.json()` 分类状态、保留 Retry-After 并脱敏；`request()` 仍提供兼容的状态/JSON。人工核实流程见 [API](api.md#人工核实未知写入)。

## 页面扩展

[SchemaEditor](../apps/web/src/schema-editor.tsx) 支持对象、字符串、数值、布尔、枚举和数组。普通字段默认表单展示，复杂联合结构回退高级 JSON，最终校验仍在服务端。用 Schema 的 `title/description` 提供易读标签。

业务包在自身 `views.tsx` 导出 `ModuleView[]`，通过 [packageViews](../modules/package-views.ts) 静态注册；公共类型来自 `cloud-agent/ui`，重复模块 ID 启动即拒绝。支持 `Input` / `Result` / `Actions` 组件。Actions 接收 `detail/client/refresh`，使用经过平台鉴权的类型客户端，不能从服务器响应加载可执行代码。Input 接收 `schema/value/onChange/label`（value 为 JSON 字符串）；Result 接收 result。文本模块已有自定义结果展示，其余模块使用通用 JSON 展示。自定义 UI 随可信源码构建，不动态执行 API 返回的组件。主入口、工作台、创建表单、任务详情和权限页面分别维护。

验证正常完成、输入错误、能力不足、等待恢复、重复请求、未知写入及撤权；外部协议使用受控服务。复用 `tests/helpers.ts`，测试替身放 `tests/fixtures/`。改变编排、Schema、工具或授权语义时升级模块版本；运行 `pnpm check`，按 [开发指南](development.md) 补充相关验收。

## 邮件路由

启用邮件后，默认把正文提交给 `text`。自定义业务在 `apps/container.ts` 的 `MailChannel` 装配处传入纯路由函数，例如：

```ts
const route: MailRouter = (message) => ({
  moduleId: "report",
  input: { title: message.subject, values: JSON.parse(message.text) },
});
```

`MailRouter` 从 `packages/mail/contracts.ts` 导入；示例要求正文是数字数组，模块 Schema 仍会校验。邮件身份由通道绑定，路由不能替换；生产实现应处理格式错误。整体注入使用 `createContainer(config, { mail: { settings, provider, route } })`，配置和 Provider 类型同见该协议。邮件补充输入/确认通过 TaskService 复用原等待服务，路由不处理它们。不要让模型选择操作者或任意收件人。

多账户注入使用 `createContainer(config, { mails: [{ settings, provider, route }] })`，每项设置稳定 `settings.id`，旧 `mail` 单对象仍兼容。扩展供应商实现 `MailProvider.list/read/send`，可选 `verifyWebhook`；标准化消息必须显式给出真实认证结果，不得信任原始 From 或 Authentication-Results。游标为供应商私有字符串，`hasMore:false` 表示已追平（即使持久游标非空）。`id` 用于取信定位，RFC `messageId` 用于回复，`deduplicationId` 可提供跨定位重投的稳定键；send 返回可匹配 In-Reply-To 的标识。只有明确拒绝才用确定失败错误码，发送结果不明必须保留 uncertain。

新协议只在适配器实现，并由 `apps/mail-factory.ts` 装配，通道及业务模块不按供应商品牌分支。凭据采用 `MailCredentials` 异步供应器；`config.mailCredentials` 可替换默认环境/文件实现，接宿主秘密管理或 OAuth 刷新服务。参考 [邮件架构](mail-architecture.md) 与真实 TLS 测试 `tests/standard-mail.test.ts`。

## 扩展基础设施

邮件/消息渠道、连接凭据、本地/S3 文件、模型配置与接入模板统一见 [通用扩展](extending.md)。三个可选示例位于 `modules/examples/`；API 查询演示受控连接，文件报告演示幂等产物，消息确认演示共用等待服务。业务模块选择 `runtime.modelProfile` 时，只绑定所选模型指纹；未选择仍兼容原默认引擎。
