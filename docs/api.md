# HTTP API

基础路径 `/v1`，输入为严格校验的 JSON。默认本地模式使用服务端固定身份；Token 模式需 `Authorization: Bearer <token>`。客户端不能指定可信工作区或操作者。

## 接口

| 方法与路径                                 | 行为                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                  | 当前身份、authMode、engine、administration                                                                                                  |
| `GET /agents`                              | 每个 ID 的默认模块版本、输入 Schema 和示例                                                                                                  |
| `POST /tasks`                              | `{moduleId,input,conversationId?}`，需 `Idempotency-Key`；返回 `202 + id/status/conversationId`                                             |
| `GET /tasks?offset=0`                      | 当前身份摘要，每页最多 50 项；模块缺失为 `available:false`；`compatibility` 为 compatible 或 requires_compatible_worker（相对当前实例配置） |
| `GET /tasks/:id`                           | task、steps、waits、invocations、artifacts、files，以及可选 modelRequests                                                                   |
| `POST /tasks/:id/inputs`                   | `{waitId,response}`，需幂等键                                                                                                               |
| `POST /waits/:id/decisions`                | `{response:{approved:true}}` 或 false，需幂等键                                                                                             |
| `POST /tasks/:id/signals`                  | `{waitKey,response}`，需幂等键和 `task:signal`，可提前到达                                                                                  |
| `POST /tasks/:id/cancel`                   | 停止后续执行，保留记录与已发生的副作用                                                                                                      |
| `POST /tasks/:id/retry`                    | 受工具语义和预算约束，不重置累计消耗                                                                                                        |
| `GET /tasks/:id/events?after=0`            | 合并冷热记录，最多 100 条持久 SSE 事件；加 `format=json` 返回 JSON                                                                          |
| `GET /artifacts/:id`                       | 权限复核后的 JSON 产物                                                                                                                      |
| `GET /conversations`                       | 最近 50 个会话                                                                                                                              |
| `GET /conversations/:id/messages`          | 持久消息，最多 200 条                                                                                                                       |
| `POST /schedules`                          | `{moduleId,input,intervalSeconds}`，至少 60 秒，需 `schedule:write`                                                                         |
| `GET /schedules` / `DELETE /schedules/:id` | 查看当前身份定时器 / 停用并保留历史                                                                                                         |
| `GET /operations` / `GET /metrics`         | 工作区快照 / Prometheus 文本，需 `operations:read`                                                                                          |
| `GET /health` / `GET /ready`（无 `/v1`）   | 存活 / 数据库、执行/维护心跳、兼容模块覆盖与维护门禁；ready 返回 database/worker/maintenance/compatible，声明业务检查时另含 business        |

管理接口见 [权限](administration.md)。可选邮件回调为 `POST /hooks/mail/:id`（单账户兼容 `POST /hooks/agentmail`）（独立验签，无 `/v1`）；`GET /v1/admin/mail` 返回工作区内 accounts，`POST /v1/admin/mail/:id/commands` 按账户执行恢复，支持 resume/retry/resolve/reset-cursor；细节见 [邮件运维](operations.md#可选邮件通道)。`202` 仅表示接受，业务是否完成须查询任务状态。

## 创建报告

```sh
curl -sS http://localhost:3100/v1/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: api-report-1' \
  -d '{"moduleId":"report","input":{"title":"示例","values":[1,2,3]}}'
```

用返回的 id 查询 `GET /v1/tasks/ID`，直到 `task.status=succeeded`，从 artifacts 取得产物 ID 后请求 `/v1/artifacts/ID`。省略 title 则等待输入：查询 waits 中 pending 项的 id，再向 inputs 接口提交 `{waitId,response:{title:"示例"}}`。

## 幂等与事件

任务幂等范围为 workspace + principal + 请求键；同键同规范化参数复用原任务，异参冲突。交互响应也持久去重；工具动作键由平台生成，跨尝试稳定。确认绑定实际参数，不能复用于其他动作。

SSE 是可续取的持久事件批次，客户端携带最后事件 ID 再请求，不是模型 token 流。工作台目前短轮询任务详情；Token 仅保存在网页内存，本地模式不能通过请求头切换身份。

## 常见错误

| HTTP / error                               | 含义                   |
| ------------------------------------------ | ---------------------- |
| 400 `INVALID_REQUEST`                      | 参数不符合 Schema      |
| 401 `TOKEN_REQUIRED/INVALID_TOKEN`         | 缺少或无效 Token       |
| 403 `FORBIDDEN/IDENTITY_REVOKED`           | 能力不足或身份禁用     |
| 404 `TASK_NOT_FOUND`                       | 不存在或不属于当前身份 |
| 409 `IDEMPOTENCY_CONFLICT`                 | 同键异参               |
| 409 `WAIT_CLOSED/APPROVAL_BINDING_CHANGED` | 等待失效或参数变化     |
| 422 `MODULE_NOT_AVAILABLE`                 | 模块/版本未安装        |

`MODULE_VERSION_CHANGED`、`APPROVAL_REJECTED`、`EXECUTION_BUDGET_EXCEEDED` 也可能出现在异步 task.error，而非创建响应。排错见 [运维](operations.md)。

## 可选文件与渠道

- `GET /v1/files/:id`：鉴权下载文件，复核任务/领域权限，过期返回 410，存储身份不匹配返回 409，摘要损坏返回 502；功能未启用为 503。
- `POST /hooks/channels/:id`：独立 HMAC 验签，无平台 Token，持久接收返回 202，事件冲突为 409；需配置对应渠道。
- `GET /v1/admin/channels`：工作区管理员查看脱敏入站/发件箱状态。
- `POST /v1/admin/channels/:id/commands`：超级管理员核实 uncertain 通知，正文 `{target,resolution:"sent"|"cancelled",reason}`，当前身份事务内复核并审计。

签名、通知及回复格式见 [通用扩展](extending.md#通用消息渠道)。

## 公共契约与客户端

`GET /v1/openapi.json` 返回 OpenAPI 3.1，采用同一平台身份验证。覆盖核心任务与身份接口、管理契约、已启用业务包的受保护路由；供应商回调、公开业务查询与宿主可选登录入口另见对应指南。请求 Schema、响应 DTO、类型客户端共同维护于 `packages/api/`。

```ts
import { CloudAgentClient } from "cloud-agent/client";
const client = new CloudAgentClient({ baseUrl: "http://localhost:3100" });
const task = await client.call(
  "create",
  {
    moduleId: "report",
    input: { title: "Example", values: [1, 2] },
  },
  { key: "report-2026-001" },
);
const detail = await client.call("detail", undefined, { id: task.id });
```

Token 模式加 `token: () => accessToken`。客户端校验请求和响应，不自动重发；不确定时使用原 key 重放，同键改参返回冲突。`downloadFile(id)` 返回 Blob，Token 只通过 Authorization 头发送。任务详情的 `files` 列表只返回未过期且已写好的元数据，实际下载再次校验权限和摘要。

## 人工核实未知写入

`POST /v1/tasks/:id/reconciliation` 需 `Idempotency-Key`，正文为：

```json
{
  "stepId": "步骤 UUID",
  "expectedAttempts": 1,
  "decision": "succeeded",
  "output": { "业务字段": "已核实结果" },
  "reason": "已核对外部系统",
  "receipt": "外部回执编号"
}
```

仅任务所有者且具备 `task:reconcile`、当前模块/工具能力可操作。任务必须在无运行租约的 `waiting_external`，目标步骤为 unknown、尝试次数匹配且配置兼容。结果必须通过工具输出 Schema；确认成功只落结果并继续后续步骤，**不会再次发送原写入**。同键同参数复用，异参冲突，原因/回执/操作者追加审计。`decision:"cancelled"` 终止任务，不能再用 retry 绕过未知副作用。

此入口需要先人工核对外部事实，不能用猜测结果代替外部回执。既有身份不会自动新增恢复权限；超级管理员也必须明确拥有该能力。渠道和邮件的未知投递仍使用各自管理命令。

## 治理与协作接口

完整运行时 OpenAPI 合并核心、管理和已启用业务路由；客户端 `.management(name, body, {id,key})` 使用同一契约。

| 入口（均以 `/v1` 开头）                           | 作用 / 权限                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /task-page?after=游标`                       | 所有者任务稳定游标分页，返回 items/next；旧 offset 接口保留                                                    |
| `GET /business`、`GET/POST /business/<包>/<路由>` | 当前可见页面/路由和业务 Schema；写操作必须有 idempotency-key                                                   |
| `GET/POST /business-jobs`                         | schedule:write；读取 desiredHash/currentHash，写 `{id,expectedHash,enabled,reason}` 并带幂等键                 |
| `GET /deployment`                                 | operations:cluster；当前/已启用修订与差异，只读，切换由部署 CLI 执行                                           |
| `GET /costs`、`GET /costs/pending`                | operations:read；当前工作区额度、待核账调用                                                                    |
| `POST /costs/resolve`                             | cost:reconcile；`{invocation,expected,amount,reason,receipt}` + 幂等键；expected 为 pending/reported/estimated |
| `GET/POST /tokens`、`DELETE /tokens/:id`          | 当前主体的附加令牌；创建 `{name,days}`，仅创建时返回明文，撤销不可恢复                                         |
| `POST /tasks/:id/delegations`                     | 所有者创建 `{delegate,actions:["read","approve"],hours,reason}`，同工作区、最长 168 小时                       |
| `DELETE /delegations/:id`                         | 所有者撤销，后续读取/审批立即失效                                                                              |
| `GET /delegated/tasks/:id`                        | 当前委托 + 双方当前能力交集 + 领域/上下文 ACL                                                                  |
| `POST /delegated/tasks/:id/approval`              | `{waitId,approved}` + 幂等键；不允许代填普通输入，审批记录真实受托人                                           |
| `POST /memories`、`DELETE /memories/:id`          | 启用记忆后使用；write 能力；创建 `{namespace,content,days}` + 幂等键                                           |

核实未知写入仍通过 `POST /tasks/:id/reconciliation`，要求 task:reconcile、当前工具权限、步骤尝试版本、外部回执与原因。工作台在对应任务详情提供入口；这不会再次发送原工具调用。模型流式增量不是持久事件，不能用增量文本作为完成回执。

## 可选公开查询与邮箱登录

业务包显式声明的 `publicReads` 挂载为 `GET /public/business/<包>/<路由>`，只返回输出 Schema 允许的公开字段，不继承本地身份或开放匿名写入。

宿主调用 `registerEmailLogin` 后才注册 `POST /auth/email/request`、`/auth/email/verify` 和 `/auth/email/logout`，分别接收 `{email}`、`{id,code}` 以及退出请求。三个接口均检查 Origin，验证成功设置 Cookie；默认装配不开放邮箱登录或注册。身份政策、会话与发件组合见 [业务复用指南](business-reuse.md#邮件和邮箱登录的宿主组合)。这些入口不在 `/v1` OpenAPI 内。
