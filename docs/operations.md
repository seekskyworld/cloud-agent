# 配置、部署与运维

Compose 启动 PostgreSQL、一次性迁移容器、API 和 Worker。API 提供网页，仅绑定宿主本机；数据库无宿主端口，运行容器使用非 root、只读根文件系统和受限数据库账号。

```sh
node scripts/init-env.mjs
docker compose up -d --build --wait
curl -sS http://localhost:3100/ready
```

初始化不覆盖已有 `.env`。默认免 Token/模型密钥、固定 `default/owner` 身份；多人入口需接入认证、TLS 与访问控制，见 [权限](administration.md)。

## 配置

应用读取环境变量及根 `.env`；Compose 显式注入变量，自定义配置须同时传给 API 和 Worker。

| 变量                                            | 默认值 / 用途                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                  | 必填；Compose 自动构造受限运行连接                                                          |
| `AUTH_MODE`                                     | `none` 固定身份；`token` 启用 Bearer                                                        |
| `LOCAL_WORKSPACE` / `LOCAL_PRINCIPAL`           | `default` / `owner`，固定身份和初始化目标                                                   |
| `HOST` / `PORT`                                 | `127.0.0.1` / `3100`；镜像内使用 `0.0.0.0:3100`                                             |
| `MODEL_MODE`                                    | `demo` 回显；`pi` 调用真实模型                                                              |
| `LLM_BASE_URL`                                  | `https://api.openai.com/v1`，模型 API 根地址，协议选择见 [模型生命周期](model-lifecycle.md) |
| `LLM_API_KEY` / `LLM_MODEL`                     | Pi 模式必填密钥 / 默认 `gpt-4.1-mini`，按供应商选择                                         |
| `LLM_INPUT_PRICE` / `LLM_OUTPUT_PRICE`          | 每百万 token 美元估价，正数，默认 1 / 4，并非报价承诺                                       |
| `WORKER_CONCURRENCY` / `LOG_LEVEL`              | 2（范围 1–32）/ `info`                                                                      |
| `POSTGRES_PASSWORD` / `RUNTIME_PASSWORD`        | 初始化随机生成；后者须 24–128 位字母数字、下划线或连字符                                    |
| `API_PORT`                                      | 宿主端口 3100，仍绑定本机                                                                   |
| `BOOTSTRAP_TOKEN`                               | Token 模式至少 24 字符，数据库只存 SHA-256 摘要                                             |
| `CONNECTIONS` / `CONNECTION_CREDENTIALS(_FILE)` | 默认空；受控连接和异步秘密供应                                                              |
| `CHANNEL_ACCOUNTS` / `MODEL_PROFILES`           | 默认空；可选渠道与命名模型                                                                  |
| `ARTIFACT_STORE` / `ARTIFACT_RETENTION_DAYS`    | 默认关闭 / 30 天；本地或 S3 文件                                                            |
| `DISPATCH_POLICY` / `EXAMPLES_ENABLED`          | 默认无配额 / false；公平领取及可选示例                                                      |
| `MIGRATION_DATABASE_URL`                        | migrate、provision、bootstrap:admin 的可选运维连接                                          |

普通 bootstrap 使用 `DATABASE_URL`；Compose 迁移容器提供 owner 连接，API/Worker 只获受限连接。已有身份角色、能力、禁用状态保持，Token 模式重跑 bootstrap 会更新指定身份的 Token 摘要。开发与测试变量见 [开发指南](development.md)。

启用真实模型可在 `.env` 设置以下项，随后重新构建/启动 API 与 Worker；Pi 缺密钥会启动失败，不回退演示：

```dotenv
MODEL_MODE=pi
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=replace-with-your-provider-key
LLM_MODEL=your-model-id
LLM_INPUT_PRICE=1
LLM_OUTPUT_PRICE=4
```

价格按供应商填写；估算成本只控制后续调用准入，单次可能超阈值，不是账单硬上限。模型密钥只交给服务端。可选 Token 登录设置 `AUTH_MODE=token` 和随机 `BOOTSTRAP_TOKEN` 后重新执行 Compose 更新；改回 `none` 恢复固定身份。

通用渠道、连接、文件、多模型和配额的配置集中见 [通用扩展](extending.md)。Compose 已映射这些变量；本地文件还需 `compose.files.yaml` 持久卷。`pnpm doctor` 只做离线配置诊断。数据库备份不含本地/S3 文件，恢复须同时还原对应对象；不要把旧存储 ID 指向新目录或新桶。

## 可选邮件通道

默认关闭。支持 **AgentMail** 和 **IMAP/SMTP**，同一部署最多配置 20 个账户；方案与供应商差异见 [邮件架构](mail-architecture.md)。账户绑定已有工作区和身份，身份需 `mail:use` 及目标模块能力，不自动创建或提升权限。默认路由交给 `text`，真实模型另行配置；业务路由见 [模块文档](modules.md#邮件路由)。

### 多账户接入

在私有 `.env` 配置账户清单与独立凭据，替换示例地址后重建 API/Worker：

```dotenv
MAIL_MODE=accounts
MAIL_ACCOUNTS='[
  {"id":"service","provider":"agentmail","address":"agent@example.com","inbox":"agent@example.com","workspace":"default","bindings":{"person@example.com":"owner"},"credential":"service-key","sendEnabled":false},
  {"id":"support","provider":"imap-smtp","address":"support@example.com","user":"support@example.com","workspace":"default","bindings":{"person@example.com":"owner"},"credential":"support-login","sendEnabled":false,"imap":{"host":"imap.example.com","port":993,"tls":"implicit","folder":"INBOX","startFrom":"new"},"smtp":{"host":"smtp.example.com","port":465,"tls":"implicit"}}
]'
MAIL_CREDENTIALS='{"service-key":{"kind":"api-key","apiKey":"replace-me"},"support-login":{"kind":"password","password":"replace-with-app-password"}}'
```

`id` 是稳定账户标识，不能换工作区或复用给另一物理邮箱；`credential` 引用密钥项，不是密钥本身。AgentMail 各账户需独立引用（可以填写相同 API Key），避免回调签名密钥互相覆盖。`pollMs` 默认 5000，可设 1000–3600000。SMTP 587 通常使用 `tls:"starttls"`；两种 TLS 模式均校验证书，不能降级为明文。服务器、端口与授权码请按实际供应商提供的信息填写。

标准邮箱首次默认跳过现有邮件；需要导入历史时显式 `startFrom:"all"`。只读 IMAP 使用 UIDVALIDITY/UID 持久游标，删除邮件不改变定位；标识周期变化时暂停，由超级管理员审计后重置。AgentMail 默认首次扫描历史 received 邮件；可用 `initialScan:"skip"` 建立跳过基线，详见 [首次收信](business-reuse.md#首次收信)。建议使用专用邮箱；下载主机默认 `cdn.agentmail.to`，可通过账户的 `downloadHosts` 配置。

标准入站独立校验完整 DKIM、From 域对齐及执行相关邮件头签名，不能只看来信自带 Authentication-Results；未签名、SPF-only 或被转发破坏签名的来信会隔离。AgentMail 使用供应商 DMARC 元数据。默认用户指令路径均拒绝自动回复、未绑定地址和歧义发件人；显式注册的服务回执先经过独立来源及请求绑定校验，见 [业务复用指南](business-reuse.md)。不采用 Reply-To/CC 作为回复收件人。原件上限 200 KB，正文最多 40,000 字符，附件不执行、不抽取。

`sendEnabled:false` 将通知保存为 draft；改为 true 只发送此后产生的通知，不补发旧草稿。回复输入提示用纯 JSON，确认提示用完整正文 `approve` / `reject`（或“确认”/“拒绝”），不含引用原文。关联依赖回复头、账户及同一身份，主题中的任务 ID 不产生权限。

### 凭据与 OAuth2

密码/应用授权码用 `kind:"password"`。OAuth2 用 `{"kind":"oauth2","accessToken":"…","expiresAt":"2030-01-01T00:00:00Z"}`，实际填写令牌真实到期时间。框架只消费有效令牌，**不提供 OAuth 登录页面或自动刷新服务**；Gmail 与 Microsoft 365 的应用授权、scopes 和协议启用由供应商/租户控制。不能保证任意邮箱仅提供一个 Key 即可使用。

可用 `MAIL_CREDENTIALS_FILE` 替代 `MAIL_CREDENTIALS`，内容为同一 JSON 映射。文件权限须 0600/0400、最大 100 KB，每次连接或验签重新读取；外部凭据服务负责提前刷新，并在同目录写临时文件后原子 rename。凭据错误会暂停该邮箱；修复后执行 resume。环境变量轮换需重建进程。

Compose 使用文件时，在自行维护的 override 中将私有目录同时只读挂载到 api/worker，设置容器内 `MAIL_CREDENTIALS_FILE`；目录挂载能看到原子换文件，单文件 bind mount 可能仍指向旧 inode。宿主文件须允许容器 node 用户读取。文件放在已忽略路径（例如 `.env.mail.local/credentials.json`），不要提交或打印内容。注册脚本在宿主运行时使用宿主可访问路径；避免将宿主路径直接传入容器。

### 回调和旧配置

AgentMail 可额外开启 HTTPS `/hooks/mail/:id`；标准 IMAP 无 Webhook。注册命令实际调用外部服务，按部署情况显式执行：

```sh
pnpm mail:webhook .env https://your-host/hooks/mail/service service
```

脚本先查询已有回调，把独立 Bearer、签名密钥及 ID 原子写回对应 credential（环境映射或已忽略的私有文件），不创建邮箱、不发邮件、不输出密钥。凭据写入环境映射后重建 API/Worker，文件轮换则即时生效。多账户仍按 pollMs 补漏，可调大至 300000；回调原字节验签、邮箱核对和事务落库后才返回 202。结果不明或远端回调存在但本地凭据缺失时，先核查恢复，不盲目重注册。

旧单邮箱模式继续支持，无需迁配置：

```dotenv
MAIL_MODE=agentmail
AGENTMAIL_API_KEY=replace-me
AGENTMAIL_INBOX=agent@example.com
MAIL_WORKSPACE=default
MAIL_BINDINGS={"person@example.com":"owner"}
MAIL_SEND_ENABLED=false
```

旧模式每 5 秒轮询（MAIL_POLL_INTERVAL_MS）；使用旧注册命令 `pnpm mail:webhook .env https://your-host/hooks/agentmail` 后，可设 `AGENTMAIL_RECEIVE_MODE=webhook`，轮询补漏间隔由 AGENTMAIL_RECONCILE_INTERVAL_MS 控制，默认 300000。旧路径只在单账户时保留。旧配置切换 accounts 时，原账户的 **id 必须等于原 AGENTMAIL_INBOX**，保持 inbox/address/workspace/baseUrl 不变，复用旧凭据及回调记录，防止另建账户重扫历史。

### 状态与恢复

`GET /v1/admin/mail` 返回当前工作区的 accounts；单账户保留旧顶层状态字段。超级管理员向 `/v1/admin/mail/:id/commands` 提交命令，均需非空 reason 并审计；旧 `/v1/admin/mail/commands` 仅单账户可用。

| action         | 字段与用途                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `resume`       | `target:"mailbox"`，修复凭据后解除暂停                                                                        |
| `reset-cursor` | `target:"mailbox"`，确认 UIDVALIDITY 变化后重新基线化；new 跳过当前存量，all 重扫历史并按 RFC Message-ID 去重 |
| `retry`        | `target:邮件定位ID`，重读 failed/quarantined，不绕过身份验证                                                  |
| `resolve`      | `target:发件箱UUID`、`resolution:"sent"或"cancelled"`；sent 需核实的 providerId                               |

收取中的恢复命令返回 `MAIL_ACCOUNT_BUSY`，稍后重试；更换物理邮箱应使用新账户 ID。认证 401/403 暂停；读取网络故障最多尝试 5 次、间隔至少 60 秒。发送前复核身份和任务状态，断连/超时/进程中断进入 uncertain，**不自动重发**；明确 SMTP 4xx/5xx 拒绝或 AgentMail 确定拒绝进入 failed。AgentMail 5xx 仍属未知。SMTP 接受不保证最终送达，人工核实后 resolve；draft/failed 均无自动补发。

收取、通知、发送独立循环和账户锁，每类最多 2 个账户并发，剩余排队；单轮每账户最多 90 秒网络预算。单账户故障不停止其他账户或任务内核。测试仅使用本地协议服务与隔离数据库，真实账号权限、签名策略和最终投递需部署后联调。

## 排错与恢复

使用 `docker compose ps`、`docker compose logs --tail 100 api worker`；日志反馈不附 `.env`、完整连接串或凭据。

| 现象                                       | 检查                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `/health` 不通 / `/ready` 为 503           | API 端口 / 数据库、最近 30 秒执行与维护心跳、模块兼容、维护模式和业务 ready 检查          |
| 任务一直排队 / 看不到模块                  | Worker 日志、租约 / 注册集合、版本、身份能力                                              |
| `compatibility=requires_compatible_worker` | 当前 API 配置不匹配该任务，保留/恢复相同模块版本及指纹的 Worker；任务不会被误领后置为失败 |
| `MODULE_NOT_AVAILABLE`                     | 缺失模块或旧版本                                                                          |
| 权限保存 409                               | 刷新列表取得当前 access_version                                                           |
| `DOMAIN_IDENTITY_NOT_CONFIGURED`           | HTTP 适配器的逐用户凭据映射                                                               |

`/v1/operations` 和 `/v1/metrics` 需 `operations:read`；统计限工作区，心跳反映基础设施。快照增加 queue（最老可执行排队秒数、相对当前实例配置的不兼容数量）、mail（收发状态/暂停邮箱数量）、loops（按职责汇总健康/失败）。指标对应 `cloud_agent_queue_oldest_seconds`、`cloud_agent_tasks_incompatible`、`cloud_agent_mail`、`cloud_agent_loops`。新增 mailAccounts 返回各账户三类心跳、暂停和扫描错误；指标为 `cloud_agent_mail_account_healthy/blocked/scan_error`，按 account 隔离。账户心跳超过 120 秒视为失联，20 个慢账户排队时应结合扫描错误和 last_success 判断。邮件错误不使任务 `/ready` 失效；应独立告警邮件积压、uncertain、blocked 和循环失败。闲置超过 30 秒的循环视为失联，超过 7 天的旧心跳清理；任务历史不随心跳清理。吞吐及跨区域容灾需自行压测。

输入/确认等待按 wait ID 响应。普通 `waiting_external` 接受信号，未知写入则按工具策略重试/对账，unsafe_write 不自动重发。失败先看 task.error 和事件；retry 不绕过预算、权限、版本及确认限制。取消只停止后续推进，补偿须显式新动作。无幂等或结果查询的写入应去业务系统核对，不能把超时当作未执行。

定时器按持久时间点生成唯一任务；停机错过多个周期合并一次，撤权或模块缺失时停用。租约和提前信号机制见 [架构](cloud-agent-architecture.md)。

## 执行轨迹归档

默认不运行、不删除历史。显式设置保留天数后，用运维数据库连接执行：

```sh
RETENTION_DAYS=90 pnpm archive          # 仅预览候选任务
RETENTION_DAYS=90 pnpm archive --apply  # 压缩归档一批，默认最多 20 个任务
```

`ARCHIVE_BATCH_SIZE` 可设 1–100；脚本使用 `MIGRATION_DATABASE_URL`，未配置则用 `DATABASE_URL`。正式受限账号只读归档表，写入需运维权限。命令可重复执行，直到候选为空；不会自动循环处理全部历史。

仅归档超过保留期的终态任务，排除待确认、未知/在途工具及未解决邮件投递。事务内锁任务，将热表 `events/invocation_attempts` 压缩到 `task_archives` 并校验摘要；每任务每批最多各 10,000 行、原文上限 32 MB。事件 API 自动合并冷热数据并保留游标；任务输入/结果、步骤、回执、等待、幂等去重及审计保留。归档后仍可按原规则重试、读取和拒绝重复创建。

这是同库压缩归档，不是过期数据销毁或无限容量方案；数据库备份包含归档。需要外部冷存储或合规删除时须另订策略，不能删除幂等记录来节省空间。

## 备份与恢复

```sh
node scripts/backup.mjs backups/cloud-agent.sql
node scripts/restore-check.mjs backups/cloud-agent.sql
```

备份含执行状态、身份摘要、审计和 JSON 产物，权限 0600，拒绝覆盖。恢复检查仅在随机临时库验证并清理。灾难恢复时停止 API/Worker，在独立实例恢复 SQL、兼容模块及配置，执行运行账号 provision，检查后切流量。备份时间点后的远端动作按原动作 ID 对账；外部业务数据须独立备份。

## 升级

先看 [CHANGELOG](../CHANGELOG.md)，记录源码/镜像/模块/配置并备份。排空任务或保留独立旧实例，停旧 Worker 后再做不兼容变更。运行 `docker compose up -d --build --wait`，依次完成 migrate、bootstrap、provision 与启动，检查 `/ready`、示例任务、等待恢复和权限。不要删卷代替升级；仅在数据库与检查点兼容时直接回退镜像。

0.1.x → 0.2.0 的兼容变化：

| 变化                                                   | 处理                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 专用业务模块/配置移除，report 升为 1.1.0，配置指纹变化 | 排空旧任务；保留旧源码与兼容数据库快照，业务连接改由适配器注入                  |
| `/v1/me` 移除 mode；`authorizeRead` 增加第四参数 steps | 改用 engine，模块自行解释原始步骤                                               |
| 初始能力来自注册模块                                   | 已有身份不自动扩权，按 [权限指南](administration.md#可信配置) 显式配置          |
| 任务摘要增加 available                                 | 模块缺失时为 false；详情、产物及含旧任务的会话消息可能返回 MODULE_NOT_AVAILABLE |

旧任务不会被新模块接管；旧任务/审计/领域表和能力字符串不自动删除，Git 历史不改写。默认不再授予旧领域 Schema 权限，升级实例的额外授权需按自身清单检查撤销。

迁移 005–007 引入：通用会话绑定、循环健康和执行轨迹归档。旧邮件线程映射会迁入通用表，旧表保留。升级时先停旧邮件 Worker，再启动新版本，避免新旧锁协议并行。0.2.0 原指纹仅对显式声明 acceptLegacyProfile 的已核验模块兼容，且模块结构与原运行配置必须一致；新指纹按模块依赖计算，**不**迁写旧任务指纹。若原配置已变，运行原配置的兼容实例处理旧任务。默认模块版本选择由“最后注册”改为“首个注册或显式清单”，多版本部署必须核对清单。

多邮箱基建新增迁移 008，保留旧邮箱主键、游标、消息和发件箱，追加 provider/remote_id/address/config_hash 及账户健康表。**先停止旧 API/邮件 Worker，再迁移并启动一致的新版本**；旧代码不能写入新增必填 remote_id，禁止新旧邮件进程混跑。

后续升级同样要求：编排、Schema、工具或权限语义变化升级模块版本；迁移只追加，API/Worker 版本一致。保留旧模块也不保证新 engine/profile 指纹兼容，框架不自动迁移检查点。

通用扩展升级包含追加迁移 009–013：渠道收发箱/审计、文件元数据、调度计数与存储身份。按上述升级流程运行迁移及 provision，再同步启动 API/Worker；不改旧邮件表和旧 JSON 产物。新增指标包括 `cloud_agent_channel_outbox`、`cloud_agent_files`、`cloud_agent_file_bytes`、`cloud_agent_files_expired`、`cloud_agent_active_leases`，按当前工作区过滤；连接限流采用固定分钟窗口。

业务包通过 `BUSINESS_PACKAGES`（默认空数组）启用，详见 [绑定与 SDK](extending.md#独立业务包与-sdk-v1)。应用迁移 014–015 后需重新 provision：人工核实审计和上下文快照禁止运行账号 UPDATE/DELETE；旧迁移不改写。已有身份需显式授予 `task:reconcile` 或业务包新能力，bootstrap 不会自动扩权。上下文快照保存在数据库内，文件对象仍须单独备份；新包/上下文供应器版本变更不自动迁移旧任务。

## 修订、运行治理与恢复

以下功能默认可选，不改变免 Token 启动。新增迁移 016–028 由部署账号追加执行；Compose 的 migrate 服务随后执行业务迁移，API/Worker 只有 DML 权限。业务目录没有启用时不创建业务 schema。

| 配置                                                                     | 行为                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `DEPLOYMENT_MANAGED=true`                                                | 只有已启用且与当前清单一致的修订可接新任务；旧任务仍需原兼容 Worker  |
| `COST_POLICY='{"workspaces":{"default":10},"modules":{"text":5}}'`       | 按 UTC 数据库月份原子预留模型费用；module 额度是每工作区内的模块额度 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example/v1/traces` | 导出 OTel Trace；默认只有关联 ID，不记录正文或凭据                   |
| `EXECUTION_POOL=default`、`EXECUTION_LABELS=[]`                          | 与模块 pool/labels 同时匹配才领取任务                                |
| `DISPATCH_POLICY='{"queueLimit":1000,"workspaceConcurrency":4}'`         | 工作区持久积压上限与运行并发上限，达到积压上限拒绝新请求             |
| `TENANT_RATE_PER_MINUTE=120`                                             | 可选工作区 HTTP 请求速率；健康探针不占业务限流配额                   |
| `MEMORY_ENABLED=true`                                                    | 启用有权限和期限的显式长期记忆                                       |
| `ARTIFACT_STORES=[]`                                                     | 多个文件存储配置；每个实例有唯一 ID 和稳定物理身份                   |

API `/health` 只看存活；`/ready` 看数据库、执行/维护心跳、兼容模块覆盖及维护门禁。工作区运维视图不返回集群 worker/loop 拓扑，额外授予 operations:cluster 才可读取。`/costs` 展示额度账本；`/costs/pending` 列待核账调用。`/costs/resolve` 需要 cost:reconcile、幂等键、expected 分类、金额、原因和回执，不能靠重发模型请求核账。修正账本不重写原任务的供应商计费回执。

部署流程（所有命令使用同一份目标配置；stage/activate/drain/resume 需要 `MIGRATION_DATABASE_URL`）：

```sh
pnpm doctor
pnpm deployment plan
pnpm deployment stage
pnpm deployment activate none '首次启用'
# 后续替换 none 为 plan 输出的当前 active 修订，防止覆盖并发发布
```

切换清单不会部署代码或回滚数据库。升级先备份、追加迁移并启动兼容新 Worker，再启用新修订；旧 Worker 保留到旧任务排空。回退代码需要保留旧制品和旧配置，重新 plan/stage/activate；不可逆业务迁移按业务恢复方案处理。停用包/默认模块入口不清除历史账本。作业配置变化会拒绝旧 hash，用带 schedule:write 的 `/business-jobs` 命令显式接受变化，不会自动补发错过的每个周期。

OIDC 是可选认证适配，必须同时设置 `AUTH_MODE=token`：

```dotenv
OIDC_AUTH='{"issuer":"https://identity.example","audience":"cloud-agent","jwksUrl":"https://identity.example/jwks","subjects":[{"subject":"external-user-id","workspace":"default","principal":"owner"}]}'
```

平台只接受通过签名、issuer/audience/exp/iat/sub 校验的令牌，映射到预登记主体，再从数据库读取当前能力。没有自动开户、跨租户登录或交互式 OAuth 登录页面。服务身份可用独立 principal + 期限 Token，附加 Token 可撤销；主 bootstrap Token 的轮换仍由部署运维管理。刷新代理需要另接安全 CredentialVault。

### 分类保留

| 数据                                                   | 策略                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| 输入、结果、步骤、等待响应、上下文、事件归档、邮件正文 | `DATA_RETENTION_DAYS` 默认 90；显式正文退役，父子任务整树处理    |
| 文件                                                   | 各存储按有效期先执行 files:prune，再退役任务；对象 IO 失败可重入 |
| 显式记忆                                               | 写入时选择 1–365 天；立即拒绝过期读取，retention 清正文          |
| 幂等摘要、请求键、身份、投递关联、审批/核实/授权审计   | 保留防重放与追责墓碑；不随正文退役删除                           |
| 业务 schema、外部业务系统、供应商日志、独立密钥库      | 业务单独制定策略；卸载包不删数据                                 |

`MIGRATION_DATABASE_URL` 指向维护目标库后，`pnpm retention` 预览，`pnpm retention --apply` 执行。只清理终态且达到期限的整棵树；未知/在途写入、待响应、未完成通知、未清文件会阻止退役。旧任务不再可 retry，原请求键保留防重放。审计原因和外部回执可能含业务信息，提交时不要填正文/秘密；当前审计保留需由运营方另定期限，**正文退役不等于合规意义的全面个人数据删除**。

### 数据库与对象联合备份

旧 `backup.mjs` 仍只备份数据库。多资源一致备份使用 `pnpm recovery`，清单保存数据库/对象摘要、存储物理身份、部署修订和逻辑凭据引用名；不包含密钥本体。默认 Compose 工具通过 `docker compose exec db` 执行 pg_dump/psql，操作库必须与 MIGRATION_DATABASE_URL 一致；外部托管数据库需替换传输层或用供应商备份。

1. 选择维护窗口，停止 API/Worker 及其他写库/写对象的运维进程，保留数据库运行。未知远端操作先核实，凭据库独立备份。
2. 保持原资源配置并提供能连接数据库的 `MIGRATION_DATABASE_URL`，运行 `pnpm recovery backup <新目录>`；目录必须不存在。备份开启维护门禁并检查无有效运行租约/未完成文件写入。
3. `pnpm recovery verify <目录>` 验证全部摘要。保持备份私有，文件包含业务数据。
4. 恢复到**空数据库**，配置原存储 ID/物理身份，运行 `pnpm recovery restore <目录>`；数据库、对象及业务 recovery 检查通过后，没有业务邮件记录的恢复会自动解除维护；包含业务邮件时仍保持维护，须先核实外部动作再显式解除。重新运行 provision 确认受限角色权限，随后再启动服务。
5. 任一步失败保留维护模式；排错后重试或显式 `pnpm maintenance off '恢复验证完成'`。这只是门禁，不代替停止所有外部写入方；不得在未核实完整性前对外开放。

`pnpm test:recovery` 自动建两个隔离测试库，真实 pg_dump/psql、两个文件存储、摘要破坏检测及修订/幂等保留演练。该测试不接触当前运行实例。

部署档位：本地为 Compose 单库；共享生产为独立 API/Worker + 托管 PostgreSQL + 私有对象存储 + OIDC/秘密供应器。Kubernetes、数据库高可用和地域灾备由部署方配置，当前没有内置 Helm/HA 控制器。可恢复的数据截至最后一次成功备份；按业务目标制定备份频率，并实测数据丢失窗口和恢复时间（RPO/RTO），本机测试耗时不是生产承诺。

## 业务邮件与公众应用扩展

按顺序应用全部待执行迁移（含 031 业务邮件和 032 应用通道）后运行 provision；升级期间停止旧 API/Worker，不混跑不认识业务邮件来源字段的版本。事务邮件、受控服务回执、初始扫描基线、Cookie、可选邮箱登录/可信注册及业务就绪检查的宿主组合见 [业务复用指南](business-reuse.md)。业务发信复用原有发件箱管理，未知投递不会重发；还原含业务邮件的备份后保持维护，须先对账外部动作再显式解除。

模块排空、部署影响检查和业务数据退出检查见 [仓库外扩展与升级](external-extensions.md#升级与退出)。应用迁移 033 后重新执行 provision，运行账号只能读取排空记录，不能修改控制表或审计。
