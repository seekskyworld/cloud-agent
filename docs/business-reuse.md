# 业务代码如何复用框架

编码 Agent 先按下表选择已有能力，再编写领域规则和协议适配。无需生成器。下面新增的接口已写入源码，但本轮未运行自动化测试或真实外部服务验收；不要把示例视为已通过生产验证。

## 能力与入口

| 需求 | 直接复用 | 业务负责 |
| --- | --- | --- |
| 网页与邮件提交同一操作 | TaskService.create、MailRouter、业务包 routes | 输入解释、业务 Schema、当前用户到主体的可信映射 |
| 操作前确认 | Tool.approval、TaskService.respond、任务等待记录 | 提供明确的已确认参数；执行时检查价格/资源版本等领域条件 |
| 恢复、重试、取消和执行审计 | Module.next、工具 effect、context.idempotencyKey | 幂等领域更新，明确未知外部动作及补偿规则 |
| 业务更新与发信原子提交 | BusinessTransactions.run + MailChannel.business.enqueue | 同一 PostgreSQL client 内更新业务数据，固定逻辑请求键 |
| 发送请求或通知 | 原有 mail_outbox 和发送循环 | BusinessMailPolicy，收件人/用途/当前领域授权校验 |
| 外部服务回执 | BusinessMailPolicy.receipt + 原有 external_signals | 严格解析、金额/资源/结果匹配、冲突处理 |
| 身份与业务权限 | IdentityService、能力、授权管理和 OIDC/Token | 可信注册流程、角色到能力的映射、对象级 ACL |
| Cookie 认证 | 可选 CookieIdentityProvider | 验证登录凭证并签发服务端会话或已有主体令牌，退出时撤销 |
| 公开查询及独立网站 | BusinessInstance.publicReads、modules/site.ts | 可公开字段、业务 UI；默认工作台仍可用 |
| 领域端口与资源生命周期 | createBusinessPorts(context)、Resources.add | 创建适配器、声明端口版本和物理身份、释放自建资源 |
| 业务就绪与恢复检查 | BusinessInstance.checks | 只读验证外部授权、待初始化状态或领域恢复不变量 |

`packages/` 不包含业务数据模型；领域仓储放在适配器，业务模块只通过声明的端口调用。框架 SQL 与宿主装配属于服务器代码，不导入浏览器或独立业务包。

## 一次请求使用一个框架任务

[外部请求组合示例](../modules/examples/external-request.ts) 是未注册的中立模块工厂。它直接使用公共 SDK：

1. `external.enqueue` 工具声明 `approval:true`，框架创建持久确认；用户确认的参数包含资源编号和版本。
2. 工具调用领域端口，在短事务内重新校验资源、更新业务数据并登记邮件。成功表示请求已入队，不表示远端操作成功。
3. 模块返回 `waitKind:"external"`、稳定 key `receipt`。回执先到时由已有信号表保留，等待创建后消费。
4. 回执唤醒任务，`external.apply` 工具用自己的稳定幂等键更新领域结果。工具结果丢失后重试，领域端口须返回原结果。

示例端口的 authorize、enqueue 和 apply 都必须由业务实现。`validateContext` / `authorizeRead` 始终复核领域权限；不能把通用幂等当成 SQL 自动去重。等待过期只表示任务超时，不代表外部动作失败；不得因此自动释放业务预留或重新提交远端请求。迟到或冲突回执会隔离，需按领域规则核实。

默认目录不会注册这个模块，也不会发信。只有显式装配真实端口并授予能力后才能使用。编排、工具或授权语义变化时升级模块版本，保留兼容 Worker 处理旧任务。

## 宿主装配与同库事务

[createBusinessPorts](../apps/business-ports.ts) 现在接收 `BusinessPortContext`：config、db、identity、tasks、conversations、transactions、mails、resources。默认返回空清单。也可通过 `createContainer(config, {portFactory})` 提供同步或异步工厂；与显式 ports 二选一。`businessPortIds` 仍用于默认 CLI 离线诊断，须同步登记端口名。

宿主工厂选择已装配的邮箱，创建领域仓储并返回 PortBinding。将自行创建的资源用 `resources.add(() => resource.close())` 登记，宿主会逆序释放。端口 identity 应包含实际资源身份和协议版本，不包含秘密；`requires` 和 `definePort` 继续检查协议。不要让模型或 HTTP 请求选择数据库、邮箱凭据或端口实现。

下面是领域适配器内的组合方式；`host` 来自端口工厂，`context` 来自工具执行上下文，`request` 是已确认并经 Schema 校验的业务参数：

```ts
const mail = host.mails.find((m) => m.store.id === "service-mail");
if (!mail) throw new Error("MAIL_ACCOUNT_REQUIRED");

return host.transactions.run(context, "example:request", async (client, actor) => {
  // 1. 使用 client 锁定领域记录，检查当前权限及 request.version。
  // 2. 按 context.idempotencyKey 去重：已有业务结果就返回它。
  // 3. 用同一个 client 更新领域数据。
  const requestKey = context.idempotencyKey;
  const deliveryId = await mail.business.enqueue(
    client,
    { ...context, principal: actor },
    "external-service",
    {
      key: requestKey,
      recipient: "service@example.org",
      subject: "Process request",
      body: JSON.stringify({ request_id: requestKey, ...request }),
      purpose: "service-request",
      waitKey: "receipt",
      metadata: { reference: request.reference, version: request.version },
    },
  );
  // 4. 用同一个 client 保存业务幂等结果，再返回给框架。
  return { requestKey, deliveryId };
});
```

`BusinessTransactions.run` 检查维护门禁、当前主体能力、执行范围、本轮 run/租约与工具步骤，在事务结束前复核中止信号和租约。回调内只做短数据库操作，不能发邮件或访问其他网络服务。领域表使用显式 schema 限定名称；先锁领域资源并复核，再写业务数据；不要依赖页面曾展示的状态。

邮件 key 必须等于工具幂等键，或为它追加稳定的 `:后缀`（同一步的多条通知）。同键改参数会报 `MAIL_COMMAND_CONFLICT`；不要使用时间或随机数生成重试请求编号。事务回滚同时撤销业务更新和发送意图。跨库更新仍需业务补偿，不承诺分布式事务。

## 业务邮件策略与外部回执

在 [apps/mail-policies.ts](../apps/mail-policies.ts) 按邮箱账户 ID 静态注册 `BusinessMailPolicy[]`。代码注入邮箱也可使用 `MailExtension.policies`。`BusinessMailPolicy`、BusinessMailInput 和标准邮件类型可从 `cloud-agent/sdk` 导入。

策略必须声明 id、version、capability，并实现 authorize(input, principal, signal)。入队和发送前都会调用；检查固定收件人、邮件用途及 metadata 中的资源版本。该钩子只做校验，不执行外部动作；入队时处在领域事务内，不能再次尝试锁住同一领域记录。入队主体还须拥有 `mail:use`。角色变更、源任务取消/失败、策略版本变化均会阻止尚未发送的请求；阻止投递不自动补偿业务数据，业务应按原请求对账处理。

需要回执时增加 receipt：

```ts
receipt: {
  sender: "service@example.org",
  principal: "external-service-receiver",
  parse(message) {
    const value = ReceiptSchema.parse(JSON.parse(message.text));
    return { key: value.request_id, response: value.result };
  },
  validate(response, request) {
    // 严格校验实际协议：资源、金额、版本及结果，不能猜测成功。
    assertMatches(response, request.metadata);
  },
}
```

ReceiptSchema 和 assertMatches 由业务定义；此片段展示接口形状，不是可直接处理任意供应商回执的解析器。服务主体须已存在，属于邮箱工作区，并具有 `task:signal` 和策略 capability；不自动创建或提升权限。

通道首先检查邮件认证和发件地址。匹配服务策略后，使用解析出的请求键查找已保存的邮件，确认策略版本、收件人、发送状态和等待绑定，再做业务结果验证。目标任务、所有者和等待键取自原请求；正文不能指定它们。服务主体记录在任务事件中，不能替用户确认操作。

已验证回执、去重凭据、信号和收件完成状态在同一个事务中保存。不为服务回执建立用户通知，不自动回信。其他自动邮件仍被拒绝。同一请求只能提供一致结果；冲突、找不到绑定、已关闭任务等情况进入隔离，不能自动改判业务成功。

同一邮箱的单个发件地址只能绑定一个回执策略，避免歧义；需要多种业务回执时在该策略内做明确的协议分流。

## 可靠投递的边界

业务邮件与任务通知使用同一张 mail_outbox、同一发送锁、发送循环和管理恢复入口。未启用发信时保存为 draft；开启后不自动补发旧 draft。发信前落库 sending；超时、断连、失联后恢复为 uncertain，不重发。发送前复核权限与策略；维护期间收信和发信循环暂停。

`purpose` 支持 reply、notification、service-request。现有任务默认 reply；服务请求和通知使用 `Auto-Submitted:auto-generated`，普通回复保持 auto-replied。AgentMail 与 SMTP 均支持。没有设置回复编号时不发送空的回复头。

外部服务必须支持这种协议并显式接收经过认证的程序请求；本框架不会去掉自动邮件标记来伪装成人工邮件。如果对方仍一律拒绝自动邮件，需要由对方维护者确认服务间协议，不能通过更换邮件头绕过规则。

确认发送完成不等于远端业务完成。管理员使用原有 resolve 只核实投递事实，不会生成业务成功回执。不要直接调用 MailProvider.send 来绕过队列；也不要另启一个循环消费同一邮箱。MailHub 会拒绝同部署中物理邮箱标识相同的消费者；代码注入未提供 physicalIdentity 时退回 provider/address 检查，但无法阻止使用不同数据库的独立部署抢同一个邮箱，部署方仍须保证邮箱归属。

## 首次收信

多账户配置可显式设置 `initialScan:"skip"`，旧单账户模式可设 `MAIL_INITIAL_SCAN=skip`。仅新建账户第一次扫描生效：扫描期间看到的邮件登记为 processed / MAIL_INITIAL_BASELINE，完整分页追平后才接收新业务。判断分页结束优先使用 hasMore；不要求持久游标为空。

省略配置保持旧行为。已有账户不会因修改配置重新跳过邮件；reset-cursor 也不清除已有基线与去重记录。IMAP 自己的 startFrom 仍决定供应商返回哪些存量邮件，两者需一致配置。基线完成前不要开放业务受理，检查管理状态中的 baseline_complete。首次扫描不是供应商原子时间快照，扫描期间到达并被扫描到的邮件也可能被跳过。

## 认证与网站入口

已有 Token、OIDC、IdentityService 和权限管理继续复用。`IdentityProvider.authenticateRequest` 是可选 HTTP 入口，接收服务端请求的 Authorization、Cookie、Origin 和 method，返回主体引用；框架随后再次调用 identity.current。旧 authenticate 实现无需改动。

宿主可通过 `createContainer(config, {identityFactory})` 获取 BusinessPortContext 并创建认证适配器。它与 identityProvider 二选一。可选 [CookieIdentityProvider](../packages/identity/cookie.ts) 包装现有 Bearer 认证及可信会话解析器：Cookie 写请求校验 Origin，支持 HttpOnly/Secure/SameSite、设置和清除 Cookie；默认 HTTPS cookie 使用 __Host- 前缀。Bearer 优先且失败不回退 Cookie，不允许使用共享 local 身份作后备。

邮箱验证码、组织 SSO 或其他登录流程仍由部署方选择。通过 `createApp(container, {registerAuthentication})` 注册隔离的可信登录/退出路由；登录握手也须自行校验 Origin、限制尝试次数并保护凭据。成功后把现有已授权主体的服务端令牌/会话放入 Cookie，不得复用 bootstrap 或共享管理员令牌；解析器返回主体引用，不能接受客户端自报角色。退出须撤销服务端令牌/会话再清 Cookie；只清浏览器 Cookie 不等于撤销。生产 AUTH_MODE 使用 token；可选 EmailLogin 复用主体和令牌体系，仅增加验证码挑战表，不默认开放注册政策。

业务包 `publicReads` 显式声明 id、input、output、handle，挂载 GET `/public/business/<包>/<id>`，不提供主体、不绕过既有受保护 routes。output Schema 必须只含公开字段。现有 routes 仍位于 `/v1/business/...` 并检查当前主体能力。公共只读接口不自动纳入旧 v1 OpenAPI，调用方按包的声明对接。

[modules/site.ts](../modules/site.ts) 在可信构建阶段选择网页标题和 `/src/` 下的入口。独立 UI 放在业务前端目录并修改该清单，不需要改 Vite、Dockerfile 或原工作台。网站入口选择只改变前端，不隐藏平台 API；仍需正确认证及按部署需求配置网关。`createApp` 的 trustedProxies 默认不信任代理头，只有可信宿主能指定地址/网段。

## 就绪、恢复和清理

业务包可贡献 `checks:[{id,phase,run}]`；phase 为 ready 或 recovery。每个只读检查最多五秒，返回 passed/failed/unchecked 和不含敏感信息的大写错误码。未知和未检查不能算通过。没有配置检查时 configured 为 0，仅表示没有声明此类检查。

`/ready` 只汇总 ready 检查的布尔结果，不公开业务细节。主机显式运行 `pnpm business:check ready` 或 `pnpm business:check recovery` 查看脱敏结果。doctor 仍是离线配置检查，不连接外部服务。

迁移后业务邮件也参与原有归档/正文退役门禁；未结束投递会阻止清理，完成后正文和 metadata 可以退役，幂等摘要和回执编号保留。业务表的保留期仍由业务负责。

联合备份拒绝仍处于 sending 的邮件。恢复后执行业务 recovery 检查；失败时不解除维护。恢复库中存在业务邮件时，即使检查通过也保持维护，先对账可能已发生的外部动作，再由可信运维执行 `pnpm maintenance off "核实原因"`。恢复到旧快照可能丢失后续发信记录，必须结合外部记录核实；维护状态不替代停机和对账流程。

## 升级与验证范围

追加迁移 031；先停止相关入口与 Worker，运行迁移及 provision，再启用新增策略。既有迁移未改写，旧邮件保留 task_id 和通知字段，新业务邮件通过 source_task 关联任务。运行角色不能修改已记录的 mail_service_receipts。

SDK major 仍为 1，本次增加可选贡献字段和公开类型，不删除旧签名。严格声明基线会要求审阅新增声明；本轮未改写兼容基线。单个邮箱内同一邮件策略当前只装配一个版本；升级策略前先排空或核实在途邮件，不混跑不同策略版本的发送器。采用这些新端口或邮件语义的业务应升级版本及端口 identity，不将旧在途任务静默切换到新协议。

本轮遵循不运行测试的要求。类型检查与静态检查只验证源码层面；数据库迁移、真实并发、邮件协议、浏览器、SDK 制品和备份恢复都需要在上线前另行验收。

## 共享模型理解、登录与会话（新增，尚未运行测试）

- 自然语言入口返回同一模块的 `{text}` 输入，在 `Module.next` 中产生 `kind:"model"`；使用 `outputSchema` 返回结构化意图。模型只解释，领域工具校验身份、资源版本和参数；写入工具设置 `approval:true`。不要在 HTTP 或邮件循环中另写模型调用循环。
- Pi 支持 `MODEL_OPTIONS={"protocol":"responses"}`，默认仍是 `completions`。`LLM_BASE_URL` 填供应商实际 API 根路径，框架不猜测或拼接 `/v1`。协议进入配置指纹；本次 Pi 引擎标识更新为 `lifecycle-v2`，存量模型任务需在旧 Worker 排空或保留兼容实例，不直接改检查点。
- `BusinessPortContext.conversations.read(principal,taskId)` 提供同会话此前成功任务的有限历史（默认 12、最多 24 条，合计 24K 字符）。每条重新检查当前领域 ACL；历史是不可信引用，不能自动重放指令。它不是长期记忆或自动摘要。
- `Tool.approvalMessage(input)` 可用纯函数呈现确认摘要；框架仍绑定全部实际参数。更改格式所代表的操作语义须升级工具和模块版本。
- `ConversationPanel` 从 `cloud-agent/ui` 导出，使用 `CloudAgentClient`，支持文本提交、历史、同会话继续、确认/拒绝及取消；模块需要接收 `{text:string}`。进度为任务轮询，没有 token 流式显示。

### 邮件和邮箱登录的宿主组合

通过 `createContainer(config,{mailFactory})` 获取数据库、身份与 TaskService，返回既有 MailChannel 的账户配置。`hooks` 可注入经过认证发件人的注册映射、收件人复核、回复解析及通知格式。邮件的认证、去重、线程、等待与发送恢复仍由框架负责；正文不得选择身份。`parseReply` 只有在可信回复绑定了原等待时才调用，返回 `undefined` 表示在原会话创建新任务，不执行确认。

`VerifiedIdentities(db,policy)` 使用迁移账号预置的 `identity_registration_policies`；运行账号只能通过 `register_verified_identity` 创建普通主体及不可变绑定，不可自定初始角色/能力。宿主只能在可靠身份验证后调用 `enrollVerified`，不要把裸 From 或请求参数视作验证凭据。

`EmailLogin` + `registerEmailLogin` + `CookieIdentityProvider` 提供可选邮箱验证码登录。会话复用 `principal_tokens`，验证码 10 分钟、最多 5 次，限邮箱/IP 请求频率；验证码经认证加密保存，仅投递前解密。凭据需要高熵服务端 secret，不能由模型/客户端提供。登录提供 `/auth/email/request`、`verify`、`logout`，都检查 Origin；代理需正确处理可信来源地址。

登录等非任务邮件通过 `MailChannel.system`、静态 `SystemMailPolicy` 放入同一个 `mail_outbox`；队列保存引用，不保存验证码明文。它是可信宿主端口，不向模型提供任意发信工具。`prepare` 有 5 秒上限，策略版本改变或验证码过期会拒绝投递。`SHOP` 等领域名不属于框架接口。

### 请求关联、投递及恢复

`BusinessMailInput.correlationKey` 用于外部协议的业务请求编号，和框架步骤 `key` 分开；均持久化并有唯一约束。`receipt.parse(message,related)` 可读取由真实 In-Reply-To 关联的原请求。解析仍需精确匹配服务发件人、参数和结果；重发相同业务请求不能换请求编号。

`BusinessMailPolicy.authorize` 在入队和投递前执行；入队时不能通过另一条数据库连接读取尚未提交的新领域记录。可选 `authorizeDelivery` 专门检查投递前已提交的领域状态。所有校验只读、有界；请求或来源任务失效会取消尚未发出的邮件。业务通过已有 `BusinessJob` 消费投递终态，决定是否释放预留；框架不猜测领域补偿。

`BusinessTransactions.run` 对业务 `Problem` 且已成功回滚的情形标记明确未提交；提交失联、回滚失败及未知异常继续按未知写入处理。不得在回调执行网络动作。

迁移 `032_application_channels.sql` 必须先应用并重新运行 provision，再应用业务迁移。验证码到期密文在后续登录请求及框架正文退役时清理；90 天以上挑战记录在正文退役时删除。领域收货信息、归档旧表、日志和供应商副本需要各自保留策略，框架退役不等于删除第三方邮件。

API、Worker 和部署/恢复/业务检查等运维命令共用 `apps/application.ts` 装配入口；默认导出 `createContainer`。业务宿主应在这里统一选择自己的工厂，避免运行时已注入领域端口而检查脚本仍使用默认空端口。
