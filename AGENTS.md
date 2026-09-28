# Coding agent guide

公共开发约定，不依赖本机技能或私有协作系统。修改前阅读 [README](README.md)、[架构](docs/cloud-agent-architecture.md) 和相关源码，检查 `git status --short`，保留他人改动。接业务先看 [业务复用指南](docs/business-reuse.md)，再看 [模块与适配器](docs/modules.md)。优先复用现有任务、确认、身份和投递机制；领域 SQL 与框架同库组合时使用宿主事务端口，不在业务中复制第二套通用状态机。

## 边界与不变量

- `packages/` 不导入 `apps/`、`modules/`、`adapters/` 或模型 SDK；业务在模块，外部协议在适配器，通过 `apps/container.ts` 装配。默认集合在 `modules/catalog.ts`，Worker 不按业务名分支。
- `Module.next(input, steps)` 必须纯净：不访问网络、数据库、时钟或随机数。每个逻辑步骤 key 稳定，重试复用 `context.idempotencyKey`。
- 声明工具副作用；未知写入不能直接重发，`reconcilable_write` 必须实现 `reconcile`。确认绑定参数，拒绝、过期、改参不得被 retry 绕过。
- 身份、工作区和凭据来自可信服务端，不来自模型或客户端。角色不产生业务通配能力；授权变更须有版本检查、原因、幂等和审计。
- 旧租约或已取消任务不得提交结果；取消不撤销远端动作。模块通过 `validateContext` / `authorizeRead` 复核领域权限，核心不猜测步骤数据形状。
- 修改编排、协议、工具或授权语义时升级模块版本；迁移只能追加，不编辑已应用文件。模块为可信部署代码，不动态求值用户代码。

- 通用发行版不内置领域业务；新业务通过独立包和端口装配。架构测试夹具放在 `tests/fixtures/`，不得被生产入口导入；本地 `project/` 参考仓库不纳入 Git 或镜像。

## 代码与文档

TypeScript 严格模式，不用显式 `any`；优先短函数和显式参数，复杂约束与并发逻辑用简洁中文注释。改动聚焦目标，配置、API 和文档与实际行为同步，说明错误及恢复语义。

不提交 `.env`、凭据、备份、本机协作资料；公开文档不引用私人路径或会话。不要打印完整连接串、降低隔离检查或清空用户数据库来通过测试。

## 验证与交付

环境准备见 [开发指南](docs/development.md)，按变更范围执行：

| 变更 | 验证 |
| --- | --- |
| 交付工具、发布或公开边界 | 另跑 `pnpm test:tooling`、`pnpm secrets:check`；候选包只从干净提交生成并校验 |
| 仅文档 | `pnpm docs:check`、`git diff --check` |
| 代码 | `pnpm format:check`、`pnpm check` |
| 页面 | 另跑 `pnpm test:browser`，检查桌面和手机截图 |
| 部署、迁移或授权存储 | 构建镜像，另跑 `pnpm test:compose` |
| SDK、公共 API、业务包 | 另跑 `pnpm sdk:verify`、`pnpm contracts:check`、`pnpm evaluate`；基线变更须解释兼容性 |
| 数据生命周期/联合恢复 | 另跑 `pnpm test:recovery`，只使用新建测试库 |
| 依赖 | `pnpm licenses:generate`、`pnpm licenses:check`，检查锁文件与许可 |

覆盖率仅统计 `packages/**`，不能当作整仓覆盖率。交付说明变化、实测结果和未验证范围。提交使用 `feat:` / `fix:` / `docs:` 等前缀，推送和发布须有维护者授权。
