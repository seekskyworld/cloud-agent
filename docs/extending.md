# 接入与替换基础设施

业务步骤仍写在 [模块](modules.md)，协议适配写在 `adapters/`。核心只依赖接口，静态实现清单为 `apps/extensions.ts`，生命周期由 `apps/container.ts` 管理。所有扩展都是可信部署代码，不接收用户上传并执行的插件。

## 选择接入点

| 要做什么           | 接口 / 注册表                                     | 已提供实现                             |
| ------------------ | ------------------------------------------------- | -------------------------------------- |
| 新增邮箱供应商     | `MailProvider` / `mailProviders`                  | AgentMail、IMAP + SMTP                 |
| 新增消息渠道       | `ChannelProvider` / `channelProviders`            | 签名 Webhook                           |
| 供应凭据、外部连接 | `SecretProvider`、`Connections`                   | 私有文件/环境 JSON、API Key/OAuth 令牌 |
| 存储文件           | `ArtifactStore` / `artifactProviders`             | 本地目录、S3 兼容存储                  |
| 选择模型           | `ModelEngine` / `modelProviders`、`ModelProfiles` | Demo、Pi（OpenAI 兼容协议）            |

注册项用 `defineExtension` 声明 `id`、Zod `schema`、`capabilities`、`create`，可用 `identity` 描述物理连接身份。`describe()` 返回 JSON Schema 和实现能力；这些能力是接口说明，不代替用户授权。新增实现后在 `apps/extensions.ts` 导入并 `.register(extension)`，公共解析器与工厂不增加供应商品牌分支。配置 Schema 仅存凭据引用，不能直接放秘密。

```sh
pnpm extension:create mail my-mail
pnpm extension:create channel my-channel
```

骨架默认拒绝外部调用，实现认证、协议和错误映射后才能注册；`tests/extension-contracts.ts` 提供共用断言，具体协议仍需实测。模板重复生成拒绝覆盖。连接器自有 `close()` 由宿主逆序释放，启动中途失败也清理已创建资源；`createContainer(config, { modules, engine, modelProfiles, artifactStore, mails, channels })` 注入的实例由调用者关闭。

## 连接与凭据

API/Worker 使用相同的可信配置；`endpoint` 固定在服务端，客户端/模型不能覆盖连接地址或操作者。连接使用前刷新当前身份、匹配工作区/用户/能力，随后取凭据。每个连接的 `ratePerMinute` 是数据库共享的固定分钟窗口，超额返回 `CONNECTION_RATE_LIMITED`，不自动重发外部写入。

```dotenv
CONNECTIONS='[{"id":"example-api","endpoint":"https://api.example.com","credential":"api-key","grants":[{"workspace":"default","principals":["owner"],"capability":"example:query"}],"ratePerMinute":60}]'
CONNECTION_CREDENTIALS='{"api-key":{"apiKey":"replace-me"}}'
```

生产可改 `CONNECTION_CREDENTIALS_FILE` 为容器内私有 JSON 文件（0400/0600），目录只读挂载；每次打开文件，原子替换即可轮换。错误只返回脱敏代码。OAuth 项为 `{"kind":"oauth2","accessToken":"...","expiresAt":"未来的 ISO 时间"}`，刷新/授权页面由外部供应器负责；邮件还支持密码等协议特有格式，见 [运维](operations.md#可选邮件通道)。邮件优先用 `MAIL_CREDENTIALS(_FILE)`，未配置时复用 `CONNECTION_CREDENTIALS(_FILE)`。

## 通用消息渠道

```dotenv
EXAMPLES_ENABLED=true
CHANNEL_ACCOUNTS='[{"provider":"webhook","id":"reviews","workspace":"default","bindings":{"external-user-1":"owner"},"moduleId":"message-review","credential":"channel-key","sendEnabled":false}]'
CONNECTION_CREDENTIALS='{"channel-key":{"signingKey":"replace-with-at-least-32-random-characters"}}'
```

以上凭据映射须与其他连接合并。已有身份需通过管理接口显式授予 `channel:use` 和模块能力（本例 `example:review`），重跑 bootstrap 不会扩权。新安装启用示例时会初始化对应能力。

向 `POST /hooks/channels/reviews` 发送 JSON：

```json
{
  "eventId": "external-event-1",
  "subject": "external-user-1",
  "threadId": "thread-1",
  "input": { "text": "请确认" }
}
```

头部 `x-channel-time` 为十位 Unix 秒，`x-channel-signature` 为 `HMAC-SHA256(signingKey, timestamp + "." + 原始正文)` 的小写十六进制；允许五分钟时差。`subject` 必须由可信上游核验身份再签名，不能让外部调用者冒充其他用户。验签后先落库返回 202，Worker 再推进；同事件重放幂等，改正文返回 409。

启用投递需配置固定 HTTPS `url` 和 `sendEnabled:true`。通知为 `{"id":"通知 UUID","payload":{...}}`，包含任务状态、结果或等待信息，使用同样的签名头及 `idempotency-key`；接收方按通知 ID 去重。回复以新 `eventId`、同一账户/subject，携带 `replyTo:通知 UUID` 和 `response:{"approved":true}`；服务端解析等待目标，不接受任意任务/wait ID。邮件与此入口共用身份映射、会话、任务/等待服务和失败分类，邮件保留其专用游标及协议表。

4xx 为明确失败，网络中断/5xx/进程中断为 `uncertain`，不会自动重发。`draft` 不因开关变化自动补发。管理员通过 `GET /v1/admin/channels` 查看脱敏状态，超管经 `POST /v1/admin/channels/:id/commands` 提交 `{target,resolution:"sent"|"cancelled",reason}` 核实未知投递并记审计；当前没有批量重放、入站重试或自动对账接口。变更渠道物理身份/路由需新 ID，绑定和发送开关可以更新。

## 文件产物

默认关闭，旧 JSON 产物仍可使用。工具调用 `ArtifactFiles.put(context, name, mediaType, Buffer)`，返回元数据和鉴权下载路径；内容不可覆盖，同调用同名改内容被拒绝。限制 10 MB，保存 SHA-256、大小和过期时间，默认 30 天。写入失败可能留下不被引用的对象，重试按稳定键复用；运维删除孤立对象前应核对元数据及正在执行的任务。

```dotenv
ARTIFACT_STORE='{"provider":"local","id":"files-v1","directory":"/app/files"}'
ARTIFACT_RETENTION_DAYS=30
```

Compose 本地文件需要共享持久卷：

```sh
docker compose -f compose.yaml -f compose.files.yaml up -d --build --wait
```

镜像提前创建可由非 root 用户写入的目录。多主机部署用共享文件系统或 S3：

```dotenv
ARTIFACT_STORE='{"provider":"s3","id":"files-v1","region":"us-east-1","bucket":"your-private-bucket","credential":"s3-key"}'
CONNECTION_CREDENTIALS='{"s3-key":{"accessKeyId":"replace-me","secretAccessKey":"replace-me"}}'
```

可附加 `endpoint` 连接 S3 兼容服务。API 代理 `GET /v1/files/:id` 下载，每次复核当前任务/领域权限、有效期和摘要，不生成绕过撤权的公开 URL。相同存储 ID 绑定目录或桶；迁移物理位置需显式数据迁移方案，不能只改配置。自定义实现必须声明稳定 `identity`，确保指向同一物理位置。

`pnpm files:prune` 预览；`pnpm files:prune --apply` 每次最多删除 100 个当前存储的过期对象，再删元数据。数据库备份**不包含文件对象**；需同时备份本地卷/桶，恢复保持存储 ID、位置身份和对象快照一致。对象存储生命周期不得早于框架有效期。

## 多模型与公平调度

`MODEL_PROFILES` 定义独立模型配置；模块声明 `runtime:{model:true,modelProfile:"fast"}`。未指定时保留旧 `MODEL_MODE`/`LLM_*` 行为。没有静默 fallback；配置变更后只有依赖它的旧任务停止被不兼容 Worker 领取。

```dotenv
MODEL_PROFILES='[{"id":"fast","provider":"pi","connection":"llm-api","model":"your-model","inputPrice":1,"outputPrice":4}]'
DISPATCH_POLICY='{"workspaceConcurrency":4,"workspaces":{"priority-workspace":8},"modules":{"file-report":2}}'
```

模型连接 `llm-api` 需在 `CONNECTIONS` 中声明和授权，采用相同秘密供应器和限流。指纹包含模型配置、连接与授权配置，不含密钥值；改密钥不影响恢复。自定义模型应以实现/协议版本构成指纹，变更行为须升级版本。

领取按工作区与模块轮转；`workspaces` 覆盖默认工作区上限，`modules` 是**每个工作区内**该模块的运行租约上限。多个 Worker 在同一数据库短事务内准入，过期租约不占配额，等待任务不占执行槽。配额变小不强停既有运行任务，只阻止新领取；它不是 CPU/内存隔离，也不承诺大规模队列吞吐。

## 诊断与示例

`pnpm doctor` 不联网、不读写数据库，检查配置关系和凭据可读性；失败只输出组件与错误码。它不验证真实密码、远端连接、桶权限或本地目录写权限。

启用 `EXAMPLES_ENABLED=true` 后出现三个可运行模块，默认仍关闭：

| 模块             | 需要的配置                                      | 输入                           |
| ---------------- | ----------------------------------------------- | ------------------------------ |
| `api-query`      | 名为 `example-api` 的连接，授予 `example:query` | `{"path":"/status"}`           |
| `file-report`    | `ARTIFACT_STORE`，授予 `example:file`           | `{"text":"Hello Cloud Agent"}` |
| `message-review` | 授予 `example:review`；可用网页/API 或上述渠道  | `{"text":"请确认"}`            |

新安装的 bootstrap 自动授予启用示例的能力；已有身份使用管理界面显式授权。示例位于 `modules/examples/`，不要求改变核心。验收覆盖真实 PostgreSQL、受控 HTTP/S3/邮件协议替身；接入真实服务仍需按供应商实测。实施范围见 [计划与验收](extensibility-plan.md)。

## 独立业务包与 SDK v1

推荐把一个业务的清单、配置、模块和页面放在同一目录，用 `pnpm package:create my-business` 生成并自动注册到 `modules/packages.ts`。源码宿主使用下列导出入口；`pnpm sdk:build && pnpm sdk:verify` 可产出并验证独立制品，尚未发布 npm：

| 入口                 | 用途                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `cloud-agent/sdk`    | `defineBusinessPackage`、Module/Tool/Model 协议、`ExecutionFailure`、上下文端口 |
| `cloud-agent/client` | `CloudAgentClient`、API DTO 与 `ApiError`，可在浏览器使用                       |
| `cloud-agent/ui`     | `ModuleView`、输入/结果/操作组件类型及 `defineViews`                            |

包清单声明 `id/version/sdkMajor:1/permissions/config/requires/create`。`create(config, services)` 返回 modules，以及可选 routes/jobs/pages/dependencies/close；新包默认不启用，部署通过 `BUSINESS_PACKAGES` 选择。未知包、错误 SDK、配置、权限声明和缺失依赖在启动时失败。包属于可信代码；这些接口不是安全沙箱。

```dotenv
ARTIFACT_STORE='{"provider":"local","id":"reports","directory":"/app/files"}'
BUSINESS_PACKAGES='[{"id":"starter","config":{"prefix":"报告"},"bindings":{"output":"reports"}}]'
```

仓库附带 `modules/starter-package`：声明 `output:{kind:"artifacts"}`，通过 `services.files("output").put(...)` 生成文件。输入 `{"text":"Hello Cloud Agent"}`，模块为 `starter-report`、能力为 `starter:run`；新安装 bootstrap 授权，已有身份须显式授权。Compose 本地文件使用前述共享卷覆盖文件。

`requires` 支持 connection/model/artifacts/context/channel/port 六种资源，部署把逻辑别名绑定实际 ID；可用 `optional:true` 声明可选依赖，未绑定时不能调用。模型和上下文 ID 必须同时声明在模块 `runtime`，推荐从 `services.model/context(alias)` 取得。渠道别名仅提供路由配置 ID，通知仍由渠道层负责；不提供业务内绕过发件箱的发送函数。

同一业务可以把连接改绑另一个已授权服务、把文件绑定本地或 S3，业务代码不变；协议不兼容时仍需适配器。包版本、配置、依赖物理身份进入恢复指纹，秘密值不进入；改绑会隔离旧任务，保留兼容 Worker 处理旧任务。迁移文件/数据源必须另做数据迁移，不能只改 ID。

开发命令已经启用 `development` 导出条件；独立源码包测试使用 `tsx --conditions=development`，生产先 `pnpm build`，Node 加载 `dist/`。不要直接导入内部持久层或 `apps/`。前端清单单独放在 `modules/package-views.ts`，防止浏览器打包数据库/模型 SDK。

扩展可通过 `references(config)` 声明 connection/secret 引用，通过 `diagnose(config, context, signal)` 实现离线检查。未实现诊断返回 `unchecked`，doctor 不报成功；诊断超时五秒，错误脱敏。内置诊断只验证配置、依赖和凭据形状，不代表远端可用。代码注入的上下文供应器不在 CLI 配置清单中，由宿主启动和集成测试验证。

## 可选上下文与模型结果

`createContainer(config, {contexts:[provider]})` 注入 `ContextProvider`。供应器实现 `id/version/identity/capability/load(query, principal, signal)/authorize(documents, principal, signal)`；`identity` 绑定数据源及检索策略且不能包含秘密。文档为 `{id,text,metadata?}`，领域 ACL 由供应器负责，拒绝访问时抛 `Problem(403, "DOCUMENT_REVOKED")`。

模块声明 `runtime:{model:true,contexts:["docs"]}`；模型动作的 `request.contexts` 为 `[{provider:"docs",query:{topic:"..."}}]`。平台将首次授权后的检索结果保存为不可变快照，重试复用原内容，避免同一步静默换上下文；重新调用模型、继续任务、读取详情/事件/产物时仍复核当前身份、能力和文档 ACL。更换供应器版本/身份会隔离旧任务。跨工作区/所有者拒绝访问。

每轮最多 4 个引用、20 篇文档、48 KB JSON；单文档文本最多 24,000 字符。上下文作为不可信引用数据注入，不授予工具权限；供应器不得把系统指令或其他租户内容混入授权文档。快照与数据库一起备份，包含文档正文，应按业务数据管理；不做向量索引或自动长期记忆；显式长期记忆和快照退役见下文。可运行参考见 `tests/context.test.ts`。

模型动作还可指定 `outputSchema`、`maxOutputTokens`、`inputTokenBudget`、`timeoutMs`、`reasoning`、`cache` 和可选 `checkpoint`。平台默认请求 `reasoning:"none"`，Pi 显式发送 `reasoning_effort:"none"` 与空工具列表，单次调用受任务剩余总预算限制。供应商必须支持所选推理字段和值；命名 Pi 配置声明 `reasoning:true` 后可请求其他等级，不代表该服务支持所有等级。`cache:"disabled"` 只关闭 SDK 提示缓存请求并移除缓存键，不保证网关或供应商禁用服务器缓存；具体关闭方式由部署方按网关协议配置并实测。模型适配器必须关闭 SDK 内部自动重试，由平台按限流、队列超时和执行超时统一退避；客户端取消不代表供应商停止计算，所以任务必须缩短阶段并依赖租约校验阻止旧结果提交。

需要处理长文档时，把改写、提取、审核和审核后构建拆成多个稳定模型 Step。提取结果只保存元数据和 `sourceDigest`/原文范围，审核通过后再启动图谱或索引构建。声明 `checkpoint:{key,sourceDigest}` 后，模型返回结果会在最终 Step 提交前落入可恢复检查点；恢复时会校验任务配置、模型、提示词和完整请求参数指纹。失配结果丢弃后重新调用仍扣除旧调用的费用和耗时；已完成的步骤始终由原有持久步骤复用。SDK 的 `sourceDigest`、`ExtractedReference` 与 `restoreSourceRanges` 在函数入口拒绝摘要变化、非法行号、范围越界和重叠。默认允许局部摘录；要求全文无遗漏时传入 `{coverage:"full"}`，包括末尾空行必须覆盖；输出换行规范为 LF。

Schema 使用 JSON Schema draft-07（不含远程引用）；输入预算按 UTF-8 字节加工具定义/开销保守计量，**不是精确 tokenizer**。引擎可实现 `countTokens` 提供专用分词计量。工具调用回合保留原协议，由模块决定后续步骤。

## 完整应用与独立制品

`pnpm sdk:build` 生成 `dist/sdk-package`；在该目录执行 `npm pack` 后，外部包用本地产物安装，导入 `@cloud-agent/sdk`、`@cloud-agent/sdk/client`、`@cloud-agent/sdk/ui`。`pnpm sdk:verify` 会在临时工程中编译并加载记录协议与端口组合两个中立测试包，从 tarball 在全新工程真实安装并编译运行，也验证 UI 入口；不链接宿主源码或 node_modules。公共协议仍为 SDK major 1；不应导入制品内部路径。

完整业务接入通常修改 3 个静态装配位置：`modules/packages.ts` 注册包，`apps/business-ports.ts` 提供领域适配，`modules/business-views.ts` 注册需要的页面；无领域端口/页面时可省略。宿主配置通过环境变量绑定，Worker 不需要新增业务分支。

上述路径适用于使用平台身份和工作台的业务。公开读取现在可通过 publicReads 声明，独立网页入口通过 modules/site.ts 选择；Cookie 认证可复用已有主体。宿主端口工厂可以注入 BusinessTransactions 和已装配邮箱，业务邮件复用原有发件箱。完整调用与边界见 [业务复用指南](business-reuse.md)。邮箱验证码/注册策略和领域数据仍由接入方实现，框架没有新增第二套用户或确认系统。

- **迁移**：包声明 `migrations:[{id,sql}]`；部署账号运行 `pnpm migrate:business`，创建 `business_<包名>` schema，记录校验和并给运行角色 DML。已经应用的迁移不可改写。业务 SQL 是可信部署代码，schema 不是恶意插件安全边界。
- **领域端口**：`definePort<T>(id, version, check)` 声明协议；`requires` 使用 `{kind:"port",protocol:{id,version}}`，`services.port(alias,token)` 获取实现。适配器自行复核领域权限、并发版本和幂等，不能相信客户端主体。
- **API**：`routes` 定义 GET/POST、Schema、capability 和 handle；自动挂载 `/v1/business/<包>/<路由>`。POST 必须用 context.key 在领域事务中去重，平台记录 started/succeeded/unconfirmed 审计但不重发。
- **作业**：`jobs` 定义模块、输入及间隔，部署的 `jobs` 显式绑定 workspace/principal；按持久触发点去重，恢复不补发所有错过周期。配置漂移先拒绝运行，通过 `/business-jobs` 比较 hash 后显式更新/停用；关闭整个包时其作业停止调度。
- **页面**：服务端 pages 控制可见导航，前端 `defineBusinessViews` 注册可信组件，必须声明 sdkMajor:1；按需加载，不从服务器下载可执行代码。
- **依赖指纹**：默认绑定整包依赖；`dependencies[moduleId]={bindings:[别名],config:[配置键]}` 可缩窄实际依赖。声明者负责完整性，漏报依赖是业务错误。

框架不内置领域业务。通过 `pnpm package:create my-business` 创建中立起点，在 `modules/packages.ts` 注册包、`apps/business-ports.ts` 装配领域端口（同步 `businessPortIds` 供 doctor 诊断）、`modules/business-views.ts` 注册可信页面。默认端口和独立页面清单为空；包需通过 `BUSINESS_PACKAGES` 显式启用。应用协议的隔离验证位于 `tests/fixtures/`，不属于可部署业务。

升级已有安装时，先排空或停用不再部署的业务入口，并从 `BUSINESS_PACKAGES` 移除对应配置；未知包会在启动时拒绝装配。源码清理不删除已有业务 schema、任务或回执，历史任务仍需保留兼容制品处理。

多存储使用 `ARTIFACT_STORES`（对象配置数组），可与旧 `ARTIFACT_STORE` 并存但 ID 不可重复。业务 output 别名可选择任意已注册实例；下载不能由请求指定桶或目录。

## 执行、模型与组合

可信模块可声明 `execution:{entry,exportName,revision,config?,memoryMb?,timeoutMs?}`，入口必须可由 Node 加载。宿主仍负责租约和提交，子进程每次只处理一个调用，不继承宿主凭据；业务依赖需可序列化/在可信工厂中装配。主进程内插件必须配合 AbortSignal；CPU 密集逻辑使用独立进程。内存限制为 V8 堆上限，不是容器级资源隔离。

模块 `runtime.pool/labels` 约束执行实例；与 `EXECUTION_POOL/EXECUTION_LABELS` 匹配才领取。`children` 动作支持最多 20 个子任务、最多 4 层、持久去重/汇总与取消传播，身份只能收窄。默认子失败使父失败；`onFailure:"collect"` 显式把失败结果交给业务处理。需要补偿时，由接入方声明独立的幂等写工具，收集子任务失败后经审批执行；取消不会自动补偿，未知原动作必须先核实。

模型可以声明 modalities/tools/structuredOutput 能力，实现 countTokens 与 stream；只有最终完整结果持久提交。Pi 当前只支持文本，图片/文件必须使用声明相应能力的适配器，不支持时明确拒绝。没有隐式模型 fallback。

`MEMORY_ENABLED=true` 注册 memory ContextProvider；`POST/DELETE /v1/memories` 需要 memory:write，检索需要 memory:read。记忆限当前主体和 namespace，1–365 天，删除或到期使旧引用失效。文档可声明 source/version、expiresAt、purposes，过期和用途不符禁止用于模型。

[MCP 适配器](../adapters/mcp/index.ts) 支持 HTTP JSON/SSE、2025-03-26 协议、会话释放和显式工具映射；从可信代码调用 `mcpTools(connections,config)` 注入模块。每个工具必须配置本地权限、effect、Schema；远端更改 Schema、返回错误或未知写入不会自动获权/重发。当前拒绝分页工具目录，不支持 stdio、远端主动采样或资源订阅。

[OAuth 刷新代理](../adapters/credentials/oauth.ts) 接受 CredentialVault，串行刷新并持久化轮换令牌；宿主提供跨进程互斥和安全存储实现。没有内置 KMS/Vault 或企业授权门户，不把刷新令牌写入任务。

HTTP 408/425 和 504 在 Pi 中分别归入 `MODEL_QUEUE_TIMEOUT` 与 `MODEL_EXECUTION_TIMEOUT`，这是适配器的重试分类，不证明网关内部在哪个阶段超时。客户端执行截止至少冷却 5 秒；网关返回的 Retry-After 另行保留。服务器仍可能继续计算，冷却不能保证远端调用不重叠。
