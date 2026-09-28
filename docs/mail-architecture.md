# 通用邮件基础设施

目标：同一部署连接多个邮箱，业务模块只接收统一任务，不依赖邮箱品牌。先实现 AgentMail 与标准 IMAP/SMTP；支持协议开放的 Gmail、Microsoft 365、QQ/163 和企业邮箱，实际认证方式及开放权限由供应商和租户策略决定。

## 调研结论（2026-09-26）

| 路径 | 官方资料与结论 | 本次选择 |
| --- | --- | --- |
| IMAP + SMTP | [IMAP RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html)：序号不能当稳定标识，须联合 UIDVALIDITY 与 UID；[ImapFlow](https://imapflow.com/docs/api/imapflow-client/) 支持只读连接、UID 和 OAuth2 | 使用成熟客户端，不自行实现协议；持久游标、只读收件、TLS、大小与超时限制 |
| Gmail | [XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol) 支持 IMAP/SMTP，需 mail.google.com 授权范围；[Gmail API 同步](https://developers.google.com/workspace/gmail/api/guides/sync) 使用 historyId，过期需全量同步 | 首先通过标准协议接入；不把 Gmail 专有同步协议放进核心 |
| Microsoft 365 | [OAuth 协议说明](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)：IMAP/SMTP 的 scopes 不同，须匹配租户设置；[Graph delta](https://learn.microsoft.com/en-us/graph/delta-query-messages) 是逐文件夹协议 | OAuth2 凭据由可替换供应器提供；Graph 保留独立适配器扩展口 |
| SMTP 发送 | [Nodemailer OAuth2](https://nodemailer.com/smtp/oauth2)：可提供有效 accessToken，不同服务 scopes 不同；SMTP 接受不代表最终投递 | 发送前持久化 sending；断连或超时为 uncertain，不能盲目重发 |
| 来信可信身份 | [RFC 8601](https://www.rfc-editor.org/rfc/rfc8601.html)：Authentication-Results 只有在已建立信任边界内可信；[mailauth DKIM](https://github.com/postalsys/mailauth/blob/master/docs/dkim.md) 提供签名、域对齐及正文覆盖信息 | AgentMail 保留供应商认证元数据；IMAP 独立验证完整正文 DKIM 及 From 对齐，不信任来信自带“认证通过”字段 |

仅能收发不等于可以作为 Agent 操作者。邮件仍需显式映射到已存在身份、当前能力校验、人工确认和审计。SPF-only、未签名或被转发破坏签名的标准来信先隔离，不能为了兼容而自动信任 From。

## 架构

```mermaid
flowchart LR
  Config[账户清单 + 凭据供应器] --> Hub[多账户调度 / 限并发 / 健康]
  Hub --> Channel[独立账户通道]
  Channel --> Port[统一 MailProvider]
  Port --> AgentMail[AgentMail REST / Webhook]
  Port --> Standard[IMAP / SMTP / MIME / DKIM]
  Channel --> DB[(游标 / 收件去重 / 发件箱 / 审计)]
  Channel --> Task[TaskService → 通用任务内核]
```

内部 accountId、供应商 inbox 和 RFC Message-ID 分别建模。去重、锁、游标、授权、回调和健康均按 accountId 隔离；同一账户的物理连接身份不得静默改变。旧单邮箱配置与记录保留可用。

新账户清单使用非秘密配置和 credential 引用；秘密单独放环境变量或只读凭据文件，不能通过管理接口返回。标准连接支持密码/授权码和 OAuth2 accessToken；文件凭据每次连接重读，支持外部凭据服务轮换。OAuth 应用注册、用户授权页面及供应商 token 刷新服务不属于任务内核；宿主可注入凭据供应器实现。

IMAP 首次默认从接入后的新邮件开始，可显式选择历史扫描；UIDVALIDITY 变化暂停并要求审计重置，不能把相同 UID 当旧邮件。RFC Message-ID 用于回复关联，IMAP 定位 ID 只用于读取。收取、通知、发送按账户独立加锁，调度限并发，避免大量邮箱占满任务数据库连接。

## 实施与验收

| 顺序 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| 1 | 账户标识、统一端口、追加迁移、多账户配置/调度、管理与回调路由 | 同供应商不同账户和不同工作区互不干扰；旧配置/数据兼容 | 已完成 |
| 2 | 凭据供应、IMAP/SMTP、统一 MIME 与 DKIM 身份核验、游标和错误语义 | TLS 协议测试、UID 去重/重置、有效/伪造签名、发送不确定性 | 已完成 |
| 3 | 部署示例、健康指标、账户恢复与接入文档 | 隔离供应商/数据库回归、完整检查、许可与容器重启/备份恢复 | 已完成 |

验收：95 项后端测试、类型/lint/文档/构建、格式和 259 项生产依赖许可检查通过；核心行覆盖率 98.75%（仅 packages）。本地 TLS 服务验证真实 IMAP/SMTP、STARTTLS 和证书拒绝；隔离 Compose 验证双供应商装配、缺凭据隔离、进程重启、最小权限、归档回放与备份恢复。页面未改，本轮未重跑浏览器测试。

默认邮件仍关闭，不连接用户真实邮箱。Gmail/Graph 原生 API、附件执行、邮箱创建及 OAuth 授权页面不是本次承诺；新供应商实现端口并由装配层注册即可复用底座。真实账号权限与投递结果需部署后分别联调。
