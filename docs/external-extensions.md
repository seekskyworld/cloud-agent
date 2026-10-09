# 仓库外扩展与升级

先阅读 [业务复用](business-reuse.md)。业务包负责领域规则；连接器负责供应商协议；宿主负责可信身份、资源绑定及关闭。不需要复制 Worker 或任务状态机。

## 独立工程

在宿主构建 SDK tarball，再生成与宿主目录分离的工程：

```sh
pnpm sdk:build
npm pack ./dist/sdk-package --pack-destination /tmp
# 使用上一步输出的实际 tgz 文件名
pnpm external:create business example-business /tmp/example-business /tmp/cloud-agent-sdk-0.3.0-preview.1.tgz
pnpm external:create mail example-mail /tmp/example-mail /tmp/cloud-agent-sdk-0.3.0-preview.1.tgz
cd /tmp/example-business
npm install
npm test
```

`@cloud-agent/sdk` 提供业务/模块协议；`/connectors` 提供邮件、渠道、存储、模型与上下文协议；`/testing` 提供邮件收取/发送契约检查；`/ui` 提供静态页面注册和 `validateBusinessViews`。后端无需 React。连接器中的文件/渠道字节协议保留 Node Buffer，邮件 Webhook 使用 Uint8Array；SDK 显式提供 Node 类型依赖。

模板不会修改宿主目录或覆盖已有工程。业务模板为纯计算；邮件模板为仅发送供应商，默认抛出 `CONNECTOR_NOT_CONFIGURED`。接入方实现真实协议、明确拒绝/未知结果语义，并在隔离邮箱验收。发送测试助手会实际调用传入的供应商，只对测试夹具或隔离账户使用。

编译包后，宿主静态导入业务包到 `modules/packages.ts`，或通过 `ContainerExtensions.businesses` 注入；连接器加入 `apps/extensions.ts` 的对应注册表。生产运行不动态加载用户脚本，不要求第三方包导入 `apps/` 或持久层源码。

## 能力与装配

`requires` 可声明 `capabilities`，例如 `{kind:"mail", capabilities:["send"]}`。宿主绑定账户 ID 后，诊断与启动都校验依赖能力；`BusinessServices.mail(alias)` 只返回绑定 ID，实际业务发送仍走宿主类型化端口及持久发件箱。

邮件供应商有三种形态：完整 `MailProvider` 保持兼容；`{mode:"send",send}` 不会进入收件轮询；`{mode:"receive",list,read}` 不允许 `sendEnabled:true`。`remote-control` 仅表示模型有取消/查询协议，不保证取消后远端一定停止。

`configuredResources(config, extensions)` 对配置和注入使用同一覆盖规则，检查重复资源、缺失依赖及依赖环；返回不可变、无凭据的清单。注入取代对应配置，附加存储继续合并；账户 ID 可使用已有邮件地址。资源身份必须是非秘密摘要，不能放路径或凭据原文。

工厂通过 `factoryResources` 声明资源 ID、能力、角色及所有权；启动验证实际产物与声明一致。工厂创建资源归宿主，通过上下文 `resources.add` 或邮件工厂返回的 `close` 登记关闭；直接注入资源归调用方关闭。失败启动会逆序释放已登记资源。默认 API/Worker 入口显式声明角色，API 不构建 Worker；为了注册和恢复指纹，仍会创建共享协议对象，扩展构造函数应避免外部 IO，实际执行在方法调用时发生。

`diagnose(config, extensions, "configuration")` 不读取凭据；默认 `configuration-and-credentials` 校验可用的凭据引用。两者均不调用工厂。注入/工厂实现的连通性返回 `unchecked`，不能当作真实服务联调成功。自定义宿主应把同一配置、扩展目录交给启动和诊断。

## 升级与退出

先应用迁移 033 并执行 provision；drain/resume 与 stage/activate 使用运维 `MIGRATION_DATABASE_URL`。generation 来自 `plan` 的排空记录，首次未登记时为 0。

```sh
pnpm deployment plan
pnpm deployment drain example-module 0 "准备退出"
# 已有任务继续运行；新任务和显式 retry 被 MODULE_DRAINING 拒绝
pnpm deployment plan
pnpm business:check retirement
# 需要恢复接单时使用 drain 返回的 generation（首次为 1）
pnpm deployment resume example-module 1 "恢复接单"
```

生产切换需启用 `DEPLOYMENT_MANAGED=true`，旧入口才会拒绝切换后的新请求；本地默认非托管模式不提供此入口约束。

`plan` 输出排空 generation 和不兼容的在途任务，包括终态任务仍未解决的工具、模型及通知副作用。`activate` 在部署锁内复核影响；任务准入使用同一共享锁，避免检查与新任务之间的竞态。阻塞时返回 `DEPLOYMENT_IN_FLIGHT_INCOMPATIBLE`。滚动升级由可信宿主通过 `activate(..., {retained: oldManifest.modules})` 显式声明仍部署的旧执行器，保留清单写入部署审计；该声明不代替运维确认旧实例可用。CLI 默认要求目标清单独立承接在途任务。

排空记录有 generation 并发保护及审计；同请求键读取已存在任务不受影响。排空不会取消任务、撤销远端动作或删除领域数据。它也会阻止在途任务创建新的子任务；涉及此类编排时，先排空根入口并等待整棵任务树收敛，再排空子模块。历史任务读取仍需要历史业务代码/权限校验，终态清空也不意味着能立即删掉模块。

业务实例可声明 `dataResources`：数据种类、备份归属、保留策略，以及 `recoveryCheck` / `retirementCheck`。两种检查必须实际注册；外部资源不能声明由宿主数据库备份覆盖。`business:check recovery|retirement` 输出资源清单与只读检查。业务负责实现领域备份/恢复/保留流程；检查通过只表示其判断通过，框架不自动执行删除或跨库备份。

## 页面与执行边界

不声明 `pages` 即为无界面业务。声明页面时，在 UI 集成测试中用完整页面清单调用 `validateBusinessViews`；缺失组件抛出 `BUSINESS_VIEW_MISSING`。运行时仍显示缺失页面的导航和明确错误，避免把前后端版本失配静默隐藏。

`TaskPort` 的 DTO、`ExecutionPort` 和 `ModelLedger` 独立于存储类；Worker 不拿 SQL 客户端。PostgreSQL 实现仍负责原子领取、租约校验、检查点、结果与事件提交，没有把原子事务拆成多个仓储调用，也不承诺已支持其他数据库。
