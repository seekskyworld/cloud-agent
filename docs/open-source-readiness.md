# 开源交付对比与改进

对比时间：2026-09-27。Cloud Agent 基线 `7ab9295`；参考 [OpenApp 5400e04](https://github.com/seekskyworld/openapp/tree/5400e047f642014f6251d479605cd657c39652c6)。这是源码和公开执行记录对比，不是生产可靠性排名。OpenApp 的[该提交 CI](https://github.com/seekskyworld/openapp/actions/runs/36008996614)显示成功；检查时公开 Releases 列表为空，因此不把已有发布脚本等同于已发布产品。

## 架构定位

Cloud Agent 以任务、步骤、等待、幂等和权限为核心，适合持续运行的任务型 Agent。OpenApp 以应用 Adapter、用户工作区、容器生命周期和访问网关为核心，适合把已有单用户 Web 应用变成独立用户环境。两者可在部署层互补，不能仅凭目录或功能数量判断谁更通用。

Cloud Agent 保持 PostgreSQL 持久队列、API/Worker 分进程、静态可信业务包和可替换供应商端口；本轮不引入容器控制面、具体领域业务或不可信插件执行。

## 可借鉴之处与对应改进

| 维度 | OpenApp 证据 | Cloud Agent 基线差距 | 本轮处理 |
| --- | --- | --- | --- |
| 产品与阅读入口 | 双语 README、教程、支持矩阵 | 英文入口较薄；入门与协议说明混在一起 | 增加中英文入门路径、独立 SDK README，修正英文 README 的过时能力边界 |
| 扩展边界 | 独立 contracts 与应用 Adapter | 核心单向依赖已有，但宿主诊断漏掉附加存储 | 修复多存储离线诊断，保持包/端口/供应商静态装配 |
| SDK 独立消费 | `scripts/release/contracts-install.test.mjs` 真正安装 tarball | 验证链接宿主 node_modules，可能掩盖缺失依赖 | 用全新工程安装 tarball，独立编译运行协议夹具和 UI 消费者；打包前清理旧产物 |
| 发布来源与完整性 | 来源提交、文件摘要、官方干净源码限制 | 有 SDK 构建与 SBOM，无统一交付目录 | 增加干净提交候选包、源码归档、SDK、SBOM、清单及篡改/额外文件/符号链接校验 |
| 贡献和维护 | Governance、Support、行为准则、Issue 模板 | 只有基本贡献/安全说明 | 增加维护规则、支持边界、行为准则和功能建议模板；不伪造托管权限配置 |
| 持续验证 | 固定 Action 提交、定期扫描、失败产物 | Action 使用浮动 tag；浏览器失败缺独立留证 | 固定 Action SHA、超时/并发控制、定期依赖和秘密扫描、诊断产物、手动候选包准备 |
| 文档可靠性 | 公开 Markdown 路径及标题锚点检查 | 仅扫描根与 docs 一层，未验证锚点 | 扫描可交付 Markdown，校验本地链接、重复标题锚点、私有/未交付文件边界 |
| 通用性证据 | 独立示例与新用户教程验收 | 已有中立包、隔离 PostgreSQL、浏览器/Compose 验收 | 保留这些验证，并补工具链故障测试；不重新引入领域业务 |

参考入口：[贡献流程](https://github.com/seekskyworld/openapp/blob/5400e047f642014f6251d479605cd657c39652c6/CONTRIBUTING.md)、[SDK 安装验证](https://github.com/seekskyworld/openapp/blob/5400e047f642014f6251d479605cd657c39652c6/scripts/release/contracts-install.test.mjs)、[发布流程](https://github.com/seekskyworld/openapp/blob/5400e047f642014f6251d479605cd657c39652c6/.github/workflows/release.yml)、[支持矩阵](https://github.com/seekskyworld/openapp/blob/5400e047f642014f6251d479605cd657c39652c6/docs/support-matrix.en.md)。

## 验证与当前边界

本轮能力通过 `pnpm check`、`pnpm test:tooling`、SDK 独立安装、API/SDK 兼容门禁、格式/文档/许可/秘密扫描、镜像和隔离 Compose 验证。候选包由 `pnpm release:prepare` 构建，并以 `pnpm release:verify` 检查；开发步骤见 [开发指南](development.md#候选交付包)。具体运行结果记录在交付说明，仓库中的工作流定义不代表它已在当前托管仓库执行。

仓库保护、CODEOWNERS 的真实负责人、私密漏洞报告、npm scope、镜像仓库、域名及签名身份需维护者在实际托管环境配置。本轮不发布、不推送，不承诺 SDK 已上架或生产 SLA。校验和用于发现内容变化，不证明发布者身份；依赖及当前候选文件扫描不代替 Git 历史审计。

后续优化以实际接入或负载证据为准：更大文件、独立执行器协议、数据库 RLS、更多 MCP 传输、动态插件沙箱均不伪装为现有能力。支持范围集中在 [SUPPORT](../SUPPORT.md)，无需不断扩充重复架构方案。
