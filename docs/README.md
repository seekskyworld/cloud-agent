# 文档

按目标阅读即可，不必通读。当前版本 0.3.0-preview.1。[English index](README.en.md)。

| 目标 | 入口 |
| --- | --- |
| 运行示例、完成首次接入 | [入门教程](getting-started.md)、[项目 README](../README.md) |
| 理解框架 | [架构](cloud-agent-architecture.md)、[分层评审与后续规划](architecture-decoupling-plan.md)、[开源对比与改进](open-source-readiness.md) |
| 接业务、模型或外部系统 | [业务包与 SDK](extending.md#独立业务包与-sdk-v1)、[模块与适配器](modules.md) |
| 编写业务代码并复用已有机制 | [业务复用指南](business-reuse.md)、[重构范围与状态](business-application-improvement-plan.md) |
| 替换基础设施、多模型、文件与渠道 | [通用扩展](extending.md)（配置、模板与三个示例） |
| 使用接口 | [HTTP API](api.md) |
| 连接不同邮箱或扩展邮件供应商 | [邮件架构与调研](mail-architecture.md)、[接入配置](operations.md#可选邮件通道) |
| 管理身份与权限 | [权限](administration.md) |
| 改代码、页面和验证 | [开发](development.md)、[Agent 约定](../AGENTS.md) |
| 配置、部署、排错和升级 | [运维](operations.md) |

预览候选、发布顺序与外部试用标准见 [预览交付说明](preview-release.md)。

支持与维护见 [SUPPORT](../SUPPORT.md)、[GOVERNANCE](../GOVERNANCE.md)。贡献见 [CONTRIBUTING](../CONTRIBUTING.md)，实施清单见 [业务接入](business-integration-plan.md)、[通用解耦](extensibility-plan.md) 与 [运行时重构](refactoring-plan.md)，版本变化见 [CHANGELOG](../CHANGELOG.md)，安全问题见 [SECURITY](../SECURITY.md)。

- [模型调用生命周期](model-lifecycle.md)：远端取消、未知请求隔离、模型容量与协议验收。
