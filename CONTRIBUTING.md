# 贡献指南

欢迎修复缺陷、改善文档、完善通用协议和添加独立示例。大型协议变更先说明场景、兼容影响与方案。

1. Fork / 克隆后建立分支，按 [开发指南](docs/development.md) 准备环境。
2. 遵守 [AGENTS.md](AGENTS.md) 的分层和不变量，一个 PR 聚焦一个目标。
3. 为行为变化补充有意义的测试，同步文档；外部协议用受控服务验证，不使用个人账号或真实资金。
4. 按变更范围运行验证：文档跑链接检查，代码跑 `pnpm check`，页面另跑浏览器，部署另跑 Compose。
5. 交付脚本与开源边界变更另跑 `pnpm test:tooling`、`pnpm secrets:check`；SDK 变更使用 `pnpm sdk:verify` 的真实外部安装验证。
6. PR 说明问题、最终行为、兼容影响和实测结果。

迁移只能追加；修改依赖须更新锁文件与第三方声明并通过 `pnpm licenses:check`。不提交凭据、备份或本机聊天记录。

提交使用 `feat:`、`fix:`、`docs:` 等前缀。贡献默认按 Apache-2.0 提供，需有权提交并保留第三方归属和许可。安全问题按 [SECURITY.md](SECURITY.md) 处理，不在公共 issue 暴露可利用细节。

维护决策见 [GOVERNANCE](GOVERNANCE.md)，参与行为见 [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)，支持范围见 [SUPPORT](SUPPORT.md)。Dependabot 只提出依赖更新，不自动合并；供应商或协议升级仍须跑相关回归。
