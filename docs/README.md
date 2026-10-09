# 文档

按运行、接入、运维的顺序按需阅读。[English index](README.en.md)。

| 目标                         | 入口                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 运行示例、完成首次接入       | [入门教程](getting-started.md)、[项目 README](../README.zh-CN.md)                                                 |
| 理解分层、任务流程与通用边界 | [架构](cloud-agent-architecture.md)                                                                               |
| 编写业务代码并复用已有机制   | [业务复用指南](business-reuse.md) → [模块与适配器](modules.md) → [业务包与 SDK](extending.md#独立业务包与-sdk-v1) |
| 替换模型、存储、凭据或渠道   | [通用扩展](extending.md)、[仓库外扩展与升级](external-extensions.md)、[模型调用生命周期](model-lifecycle.md)      |
| 连接邮箱或扩展邮件供应商     | [邮件架构](mail-architecture.md)、[接入配置](operations.md#可选邮件通道)                                          |
| 使用接口、管理身份与权限     | [HTTP API](api.md)、[权限](administration.md)                                                                     |
| 改代码、页面和验证           | [开发](development.md)、[Agent 约定](../AGENTS.md)                                                                |
| 配置、部署、排错和升级       | [运维](operations.md)、[支持范围](../SUPPORT.md)                                                                  |

框架仅内置中立示例。业务规则、领域数据模型、具体收件人及外部服务协议由独立业务包和适配器提供；生产入口不得依赖测试夹具或本地参考仓库。代码已实现、自动化检查通过和真实供应商联调是不同状态，验证方法见 [开发指南](development.md#分发与验收范围)。

贡献与维护见 [CONTRIBUTING](../CONTRIBUTING.md)、[GOVERNANCE](../GOVERNANCE.md)，版本变化见 [CHANGELOG](../CHANGELOG.md)，安全问题见 [SECURITY](../SECURITY.md)。
