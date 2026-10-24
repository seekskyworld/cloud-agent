# 业务代码如何复用框架

新增业务时，先识别哪些是已有共性，哪些是真正需要新增的规则。任务执行、确认、恢复和投递由框架承载；你实现输入、领域权限、外部协议及结果含义。

第一次接入先完成 [greeting 教程](getting-started.md#创建自己的中立包)：生成包、启用配置、授予能力，再为它增加审批。该例只修改业务包与宿主注册，不需要复制任务 API 或恢复机制。随后按下表选择业务需要的能力；生成器可选，也可以维护仓库外的独立包。

本文描述当前源码接口，验证方法见 [开发指南](development.md#分发与验收范围)，示例不代表真实供应商或生产验证通过。

## 能力与入口

| 需求                       | 直接复用                                                | 业务负责                                               |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| 网页与邮件提交同一操作     | TaskService.create、MailRouter、业务包 routes           | 输入解释、业务 Schema、当前用户到主体的可信映射        |
| 操作前确认                 | Tool.approval、TaskService.respond、任务等待记录        | 提供明确的已确认参数；执行时检查资源版本等领域条件     |
| 恢复、重试、取消和执行审计 | Module.next、工具 effect、context.idempotencyKey        | 幂等领域更新，明确未知外部动作及补偿规则               |
| 业务更新与发信原子提交     | BusinessTransactions.run + MailChannel.business.enqueue | 同一 PostgreSQL client 内更新业务数据，固定逻辑请求键  |
| 发送请求或通知             | 原有 mail_outbox 和发送循环                             | BusinessMailPolicy，收件人/用途/当前领域授权校验       |
| 外部服务回执               | BusinessMailPolicy.receipt + 原有 external_signals      | 严格解析、原请求参数/资源/结果匹配、冲突处理           |
| 身份与业务权限             | IdentityService、能力、授权管理和 OIDC/Token            | 可信注册流程、角色到能力的映射、对象级 ACL             |
| Cookie 认证                | 可选 CookieIdentityProvider                             | 验证登录凭证并签发服务端会话或已有主体令牌，退出时撤销 |
| 公开查询及独立网站         | BusinessInstance.publicReads、modules/site.ts           | 可公开字段、业务 UI；默认工作台仍可用                  |
| 领域端口与资源生命周期     | createBusinessPorts(context)、Resources.add             | 创建适配器、声明端口版本和物理身份、释放自建资源       |
| 业务就绪与恢复检查         | BusinessInstance.checks                                 | 只读验证外部授权、待初始化状态或领域恢复不变量         |

`packages/` 不包含业务数据模型；领域仓储放在适配器，业务模块只通过声明的端口调用。框架 SQL 与宿主装配属于服务器代码，不导入浏览器或独立业务包。

## 一次请求使用一个框架任务

[外部请求组合示例](../modules/examples/external-request.ts) 是未注册的中立模块工厂。它直接使用公共 SDK：

1. `external.enqueue` 工具声明 `approval:true`，框架创建持久确认；用户确认的参数包含资源编号和版本。
2. 工具调用领域端口，在短事务内重新校验资源、更新业务数据并登记邮件。成功表示请求已入队，不表示远端操作成功。
3. 模块返回 `waitKind:"external"`、稳定 key `receipt`。回执先到时由已有信号表保留，等待创建后消费。
4. 回执唤醒任务，`external.apply` 工具用自己的稳定幂等键更新领域结果。工具结果丢失后重试，领域端口须返回原结果。

示例端口的 authorize、enqueue 和 apply 都必须由业务实现。`validateContext` / `authorizeRead` 始终复核领域权限；不能把通用幂等当成 SQL 自动去重。等待过期只表示任务超时，不代表外部动作失败；不得因此自动释放业务预留或重新提交远端请求。迟到或冲突回执会隔离，需按领域规则核实。

默认目录不会注册这个模块，也不会发信。只有显式装配真实端口并授予能力后才能使用。编排、工具或授权语义变化时升级模块版本，保留兼容 Worker 处理旧任务。

## 审批后写入成功但结果未保存

以“确认后在外部系统创建工单”为例：用户确认项目与标题，外部系统创建 `T-42`，但 Worker 在保存工具结果前中断。此时外部事实是成功，本地步骤仍可能是 `running`。下面串起审批、故障和恢复；工单仅为说明，真实接口由接入方实现。

### 从审批到恢复完成

1. 模块用稳定 key（例如 `create-ticket`）返回工具动作，工具声明 `approval:true`。框架先保存步骤及实际参数，再进入 `waiting_approval`，释放 Worker 租约。
2. 用户在工作台查看参数并批准；服务端检查身份、权限、等待有效期和响应 Schema，把确认消费与任务重新入队放在同一个事务中。等待期间重启 Worker 不丢失这次申请。
3. Worker 继续原步骤，复核当前身份、领域权限和批准记录。批准仍有效、参数绑定一致时不重复询问；拒绝、过期或改参不能靠 retry 绕过。
4. 调用前记录执行尝试，将步骤 ID 作为 `context.idempotencyKey` 传给适配器。外部系统必须保存该请求键与结果的关联；本例成功创建 `T-42`。
5. 假设 Worker 此刻退出，没有保存结果。租约到期后，版本与配置兼容的 Worker 接管，先恢复原步骤，不从头创建新任务或生成新请求键。旧 Worker 即使晚到，也不能凭失效租约提交结果。
6. 工具按下面的恢复策略找回 `T-42`，框架校验输出、保存成功结果。模块随后读取该步骤结果，继续后续动作或完成任务。其他已成功步骤不重算；每个后续外部写入仍需自己的副作用策略。

| 外部系统提供的保证             | 工具声明与恢复动作                                             | 不能做什么                                             |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------ |
| 同键同参数原子去重并返回原结果 | `idempotent_write`：重用原键调用 `execute`，得到原来的 `T-42`  | 不能只发送一个幂等头，就假定供应商会去重               |
| 可按原请求键查询确定结果       | `reconcilable_write`：实现 `reconcile`，查到 `T-42` 就返回成功 | 查不到、处理中或查询超时不等于未执行，不能直接再次创建 |
| 无幂等、无可靠查询             | `unsafe_write`：保留未知结果，等待人工核实                     | 普通 retry 会被拒绝，不能通过新建任务绕过去            |

区分两个入口：**进程崩溃而任务仍为 running**，由租约到期接管触发恢复；**工具返回 unknown 或写入异常已被保存**，任务暂停在 `waiting_external`，不会自动轮询。默认情况下，后者通过工作台重试或 `POST /v1/tasks/:id/retry` 请求恢复，仍受审批、权限、配置及累计预算限制。可对账工具此时调用 `reconcile`；查询仍不确定，就再次暂停，不进行隐藏的重发。

显式声明例外：`reconciliationPolling` 允许受限原请求查询；`deferred` 用于已经受理且保存原任务号的异步写入，返回 `pending` 后释放租约、按原键收取，不能重新创建请求。`continueOnUnknown` 将未知分支交给模块决定无依赖后续工作，账本仍保持 unknown。已结束任务的隔离分支可以通过原对账接口补回执，但不会重开任务；关闭未知分支不撤销远端动作。

### 最小可对账工具

此片段展示业务包中的工具工厂。`TicketPort` 是接入方实现的外部系统端口，不是框架内置连接器。`create` 必须将原请求键传给供应商，`findByRequest` 必须按该键、当前身份/工作区和原参数核对同一操作；凭据由可信宿主注入。

<!-- example:ticket-recovery -->

```ts
import { z } from "zod";
import type { ExecutionContext, Tool } from "cloud-agent/sdk";

const TicketInput = z
  .object({
    projectId: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
const TicketResult = z.object({ ticketId: z.string().min(1) }).strict();

export interface TicketPort {
  create(
    input: z.infer<typeof TicketInput>,
    requestKey: string,
    context: ExecutionContext,
  ): Promise<z.infer<typeof TicketResult>>;
  findByRequest(
    requestKey: string,
    input: z.infer<typeof TicketInput>,
    context: ExecutionContext,
  ): Promise<z.infer<typeof TicketResult> | null>;
}

export function createTicketTool(port: TicketPort): Tool {
  return {
    name: "ticket.create",
    version: "1.0.0",
    description: "在指定项目中创建工单",
    input: TicketInput,
    output: TicketResult,
    capability: "ticket:create",
    effect: "reconcilable_write",
    approval: true,
    timeoutMs: 10_000,
    async execute(input, context) {
      const output = await port.create(
        TicketInput.parse(input),
        context.idempotencyKey,
        context,
      );
      return { kind: "succeeded", output };
    },
    async reconcile(input, context) {
      const output = await port.findByRequest(
        context.idempotencyKey,
        TicketInput.parse(input),
        context,
      );
      // 未查到确定结果时保持未知，不能把空结果当成重发许可。
      return output
        ? { kind: "succeeded", output }
        : { kind: "unknown", reconciliationRef: context.idempotencyKey };
    },
  };
}
```

端口实现须传递 `context.signal`，并把 `context.idempotencyKey` 映射为供应商请求键；不能改用当前时间、随机数或每次变化的 `runId`。查询应校验原请求的归属、参数及成功状态，不能仅凭工单标题相似判定成功。并发重复请求、去重保留期限和查询一致性都需按供应商协议验证。使用独立 SDK 制品时将导入路径换为 `@cloud-agent/sdk`。

将该工具放入模块的 `tools`，由纯函数 `next` 返回 `{ kind: "tool", key: "create-ticket", name: "ticket.create", input }`；原步骤成功后读取其 `output`，不再返回创建动作。宿主负责装配端口、注册模块并显式授予能力，模块通过 `validateContext` / `authorizeRead` 复核领域权限，接入步骤见 [模块与适配器](modules.md#编排与工具)。

若采用 `idempotent_write`，适配器必须先验证外部 API 真正兑现同键原结果约定；本例选择查询恢复，不在 `reconcile` 内再次调用 `create`。框架持久化和租约保护不能替代远端的去重或核实能力。

### 需要人工核实时

无法自动确认结果时，由具备 `task:reconcile` 和当前模块/工具能力的任务所有者核对外部回执，再通过 [人工核实接口](api.md#人工核实未知写入) 提交步骤 ID、预期尝试次数、结果、原因和回执编号。核实成功只补记原步骤结果并重新入队，**不重新发送创建请求**；不能把“没有本地成功记录”当作外部失败的证据。取消任务也不会删除已经创建的 `T-42`，撤销或补偿需单独的业务流程。

### 接入时怎么验收

- 审批前外部写入次数为 0；等待期间重启，申请仍在；有效批准后继续原步骤。
- 在外部成功后、本地保存前注入中断；恢复后结果仍为 `T-42`，外部只创建一张工单。幂等方案可有多次调用但只能有一次业务写入；查询方案应保持创建调用次数为 1。
- 查询超时、处理中或无结果时保持未知；不安全写入的普通 retry 被拒绝，人工核实补记结果也不重发。
- 拒绝、过期、改参、撤权阻止受保护执行；旧租约和已取消任务不得提交结果。

仓库的 [运行时回归](../tests/runtime.test.ts) 已覆盖“副作用已提交而结果未落库时崩溃”、同动作编号恢复、只查询不重发以及审批撤权保护；[入门教程](getting-started.md#添加工具并验证重启恢复) 可体验审批等待期间重启。这些使用受控夹具，并不证明真实供应商具有相同保证；接入方应对自己的接口重复以上验收。

## 宿主装配与同库事务

[createBusinessPorts](../apps/business-ports.ts) 接收 `BusinessPortContext`：config、db、identity、tasks、conversations、transactions、mails、resources。默认返回空清单。也可通过 `createContainer(config, {portFactory, factoryResources})` 提供同步或异步工厂；与显式 ports 二选一。默认工厂的端口名同步登记到 `businessPortIds`；注入工厂必须通过 `factoryResources` 声明资源与协议，否则启动报 `FACTORY_RESOURCES_REQUIRED`。声明格式和诊断方式见 [装配约定](external-extensions.md#能力与装配)。

宿主工厂选择已装配的邮箱，创建领域仓储并返回 PortBinding。将自行创建的资源用 `resources.add(() => resource.close())` 登记，宿主会逆序释放。端口 identity 应包含实际资源身份和协议版本，不包含秘密；`requires` 和 `definePort` 继续检查协议。不要让模型或 HTTP 请求选择数据库、邮箱凭据或端口实现。

下面是领域适配器内的组合方式；`host` 来自端口工厂，`context` 来自工具执行上下文，`request` 是已确认并经 Schema 校验的业务参数：

```ts
const mail = host.mails.find((m) => m.store.id === "service-mail");
if (!mail) throw new Error("MAIL_ACCOUNT_REQUIRED");

return host.transactions.run(
  context,
  "example:request",
  async (client, actor) => {
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
  },
);
```

`BusinessTransactions.run` 检查维护门禁、当前主体能力、执行范围、当前 run/租约与工具步骤，在事务结束前复核中止信号和租约。回调内只做短数据库操作，不能发邮件或访问其他网络服务。领域表使用显式 schema 限定名称；先锁领域资源并复核，再写业务数据；不要依赖页面曾展示的状态。

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
    // 严格校验实际协议：原请求参数、资源版本及结果，不能猜测成功。
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

宿主可通过 `createContainer(config, {identityFactory})` 获取 BusinessPortContext 并创建认证适配器。它与 identityProvider 二选一。可选 [CookieIdentityProvider](../packages/identity/cookie.ts) 包装现有 Bearer 认证及可信会话解析器：Cookie 写请求校验 Origin，支持 HttpOnly/Secure/SameSite、设置和清除 Cookie；默认 HTTPS cookie 使用 \_\_Host- 前缀。Bearer 优先且失败不回退 Cookie，不允许使用共享 local 身份作后备。

邮箱验证码、组织 SSO 或其他登录流程仍由部署方选择。通过 `createApp(container, {registerAuthentication})` 注册隔离的可信登录/退出路由；登录握手也须自行校验 Origin、限制尝试次数并保护凭据。成功后把现有已授权主体的服务端令牌/会话放入 Cookie，不得复用 bootstrap 或共享管理员令牌；解析器返回主体引用，不能接受客户端自报角色。退出须撤销服务端令牌/会话再清 Cookie；只清浏览器 Cookie 不等于撤销。生产 AUTH_MODE 使用 token；可选 EmailLogin 复用主体和令牌体系，仅增加验证码挑战表，不默认开放注册政策。

业务包 `publicReads` 显式声明 id、input、output、handle，挂载 GET `/public/business/<包>/<id>`，不提供主体、不绕过既有受保护 routes。output Schema 必须只含公开字段。现有 routes 仍位于 `/v1/business/...` 并检查当前主体能力。公共只读接口不自动纳入旧 v1 OpenAPI，调用方按包的声明对接。

[modules/site.ts](../modules/site.ts) 在可信构建阶段选择网页标题和 `/src/` 下的入口。独立 UI 放在业务前端目录并修改该清单，不需要改 Vite、Dockerfile 或原工作台。网站入口选择只改变前端，不隐藏平台 API；仍需正确认证及按部署需求配置网关。`createApp` 的 trustedProxies 默认不信任代理头，只有可信宿主能指定地址/网段。

## 就绪、恢复和清理

业务包可贡献 `checks:[{id,phase,run}]`；phase 为 ready、recovery 或 retirement。每个只读检查最多五秒，返回 passed/failed/unchecked 和不含敏感信息的大写错误码。未知和未检查不能算通过。没有配置检查时 configured 为 0，仅表示没有声明此类检查。

`/ready` 只汇总 ready 检查的布尔结果，不公开业务细节。宿主运行 `pnpm business:check ready` 查看脱敏结果，也可将阶段改为 `recovery` 或 `retirement`；声明数据资源时须同时提供恢复和退出检查，见 [升级与退出](external-extensions.md#升级与退出)。doctor 仍是离线配置检查，不连接外部服务。

迁移后业务邮件也参与原有归档/正文退役门禁；未结束投递会阻止清理，完成后正文和 metadata 可以退役，幂等摘要和回执编号保留。业务表的保留期仍由业务负责。

联合备份拒绝仍处于 sending 的邮件。恢复后执行业务 recovery 检查；失败时不解除维护。恢复库中存在业务邮件时，即使检查通过也保持维护，先对账可能已发生的外部动作，再由可信运维执行 `pnpm maintenance off "核实原因"`。恢复到旧快照可能丢失后续发信记录，必须结合外部记录核实；维护状态不替代停机和对账流程。

## 升级与验证范围

按顺序应用全部待执行迁移，包括业务邮件的 031 和应用通道的 032；先停止相关入口与 Worker，运行迁移及 provision，再启用新增策略。既有迁移未改写，旧邮件保留 task_id 和通知字段，新业务邮件通过 source_task 关联任务。运行角色不能修改已记录的 mail_service_receipts。

SDK major 为 1；新增公开声明须审阅兼容性，不得通过直接更新基线掩盖不兼容变化，验证方法见 [开发指南](development.md#sdk兼容和供应链)。单个邮箱内同一邮件策略当前只装配一个版本；升级策略前先排空或核实在途邮件，不混跑不同策略版本的发送器。采用这些新端口或邮件语义的业务应升级版本及端口 identity，不将旧在途任务静默切换到新协议。

源码静态检查不能替代数据库迁移、并发、邮件协议、浏览器、SDK 制品和备份恢复验收；上线前按 [开发约定](../AGENTS.md) 执行适用检查，记录实际结果。

## 共享模型理解、登录与会话

- 自然语言入口返回同一模块的 `{text}` 输入，在 `Module.next` 中产生 `kind:"model"`；使用 `outputSchema` 返回结构化意图。模型只解释，领域工具校验身份、资源版本和参数；写入工具设置 `approval:true`。不要在 HTTP 或邮件循环中另写模型调用循环。
- 模型协议配置、调用预算与存量任务升级统一见 [模型生命周期](model-lifecycle.md)，不直接改写旧检查点。
- `BusinessPortContext.conversations.read(principal,taskId)` 提供同会话此前成功任务的有限历史（默认 12、最多 24 条，合计 24K 字符）。每条重新检查当前领域 ACL；历史是不可信引用，不能自动重放指令。它不是长期记忆或自动摘要。
- `Tool.approvalMessage(input)` 可用纯函数呈现确认摘要；框架仍绑定全部实际参数。更改格式所代表的操作语义须升级工具和模块版本。
- `ConversationPanel` 从 `cloud-agent/ui` 导出，使用 `CloudAgentClient`，支持文本提交、历史、同会话继续、确认/拒绝及取消；模块需要接收 `{text:string}`。通用面板通过有限批次 SSE 读取任务事件；业务模块开启 `ModelRequest.stream` 后可以发布模型增量，终态仍只提交完整模型回合。

### 邮件和邮箱登录的宿主组合

通过 `createContainer(config, {mailFactory, factoryResources})` 获取数据库、身份与 TaskService，返回邮箱设置、供应商及可选路由/钩子，`factoryResources` 声明对应账户 ID、能力与角色。`hooks` 可注入经过认证发件人的注册映射、收件人复核、回复解析及通知格式。邮件的认证、去重、线程、等待与发送恢复仍由框架负责；正文不得选择身份。`parseReply` 只有在可信回复绑定了原等待时才调用，返回 `undefined` 表示在原会话创建新任务，不执行确认。

`VerifiedIdentities(db,policy)` 使用迁移账号预置的 `identity_registration_policies`；运行账号只能通过 `register_verified_identity` 创建普通主体及不可变绑定，不可自定初始角色/能力。宿主只能在可靠身份验证后调用 `enrollVerified`，不要把裸 From 或请求参数视作验证凭据。

`EmailLogin` + `registerEmailLogin` + `CookieIdentityProvider` 提供可选邮箱验证码登录。会话复用 `principal_tokens`，验证码 10 分钟、最多 5 次，限邮箱/IP 请求频率；验证码经认证加密保存，仅投递前解密。凭据需要高熵服务端 secret，不能由模型/客户端提供。登录提供 `/auth/email/request`、`verify`、`logout`，都检查 Origin；代理需正确处理可信来源地址。

登录等非任务邮件通过 `MailChannel.system`、静态 `SystemMailPolicy` 放入同一个 `mail_outbox`；队列保存引用，不保存验证码明文。它是可信宿主端口，不向模型提供任意发信工具。`prepare` 有 5 秒上限，策略版本改变或验证码过期会拒绝投递。策略名称和业务用途由宿主声明，框架不内置领域命名。

### 请求关联、投递及恢复

`BusinessMailInput.correlationKey` 用于外部协议的业务请求编号，和框架步骤 `key` 分开；均持久化并有唯一约束。`receipt.parse(message,related)` 可读取由真实 In-Reply-To 关联的原请求。解析仍需精确匹配服务发件人、参数和结果；重发相同业务请求不能换请求编号。

`BusinessMailPolicy.authorize` 在入队和投递前执行；入队时不能通过另一条数据库连接读取尚未提交的新领域记录。可选 `authorizeDelivery` 专门检查投递前已提交的领域状态。所有校验只读、有界；请求或来源任务失效会取消尚未发出的邮件。业务通过已有 `BusinessJob` 消费投递终态，决定是否释放预留；框架不猜测领域补偿。

`BusinessTransactions.run` 对业务 `Problem` 且已成功回滚的情形标记明确未提交；提交失联、回滚失败及未知异常继续按未知写入处理。不得在回调执行网络动作。

迁移 `032_application_channels.sql` 必须先应用并重新运行 provision，再应用业务迁移。验证码到期密文在后续登录请求及框架正文退役时清理；90 天以上挑战记录在正文退役时删除。领域数据、归档表、日志和供应商副本需要各自保留策略，框架退役不等于删除第三方邮件。

API、Worker 和部署/恢复/业务检查等运维命令共用 `apps/application.ts` 装配入口；默认导出 `createContainer`。业务宿主应在这里统一选择自己的工厂，避免运行时已注入领域端口而检查脚本仍使用默认空端口。
