# 模型调用的取消、隔离与恢复

任务停止推进不等于模型供应商停止计算。框架分别记录任务状态和远端调用状态；不支持远端控制的引擎仍可使用，结果未知时采用保守隔离。

## 调用与恢复

发送前，框架在 `model_requests` 保存调用 ID、任务/步骤/执行代次、逻辑操作指纹、资源 ID、截止时间和费用预留关联，不保存提示词或凭据。准入事务同时校验租约和共享容量。

| 调用状态      | 含义                                                   |
| ------------- | ------------------------------------------------------ |
| `running`     | 已登记，可能已经发送                                   |
| `cancelling`  | 已保存取消意图，准备通知远端                           |
| `unknown`     | 远端是否完成仍未确认                                   |
| `not_started` | 适配器明确证明未开始                                   |
| `completed`   | 收到完整模型终态或可信远端完成回执，不代表任务已经成功 |

超时、取消或旧 Worker 失联后，同一步骤在隔离期间不能重发。未知调用继续占用共享模型资源容量，达到未知上限后暂停新准入；等待准入不消耗模型调用次数或尝试次数。隔离到期只允许按原预算重试，记录仍是 unknown，不能据此推断供应商停止计费。

迟到完整回执只能更新原调用账本与费用，不能提交已取消任务或绕过租约。完整费用回执与账本在同一数据库事务中保存；部分用量保留为部分值，已有费用预留继续占用额度。任务累计成本只反映任务执行提交，运维核对还需关注请求账本及未结费用。

Worker 维护循环对失联调用查询状态、补发取消，控制 IO 使用独立三秒上限，不复用已取消的生成信号。多实例可能重复核对，所以控制端口必须幂等。调用元数据在隔离结束至少 30 天后清理；隔离中的任务不允许正文退役。

## 接入模型

`ModelEngine` 增加可选 `lifecycle`、`control`；调用上下文增加 `invocation`、`progress` 和可选 `report` 回执回调。已有 `next(request, tools, signal)` 实现继续兼容。引擎必须传递 AbortSignal，但框架不把本地 abort 当成远端停止证明。

- `lifecycle.resourceId`：同一个实际模型连接的配置应共用资源 ID，不能按用户或任务生成。默认 Pi 配置按连接端点生成，模型 profile 按连接 ID 生成；可显式指定共享资源。不同部署使用同一数据库时也必须使用一致策略。
- `concurrency` 默认 16，`unknownLimit` 默认 4，`quarantineMs` 默认 60000。隔离结束点为原调用截止时间加隔离时长，不是本地取消时间加隔离时长。
- `control.cancel/status`：只返回可信状态和可选用量，不触发新的生成。不支持、404、网关重启丢失状态或只有传输关闭回执时返回 unknown/transport_closed。
- `progress()`：仅在有效、非空文本/推理/工具参数增量时调用，不用于心跳。Pi 适配器已接入。

默认模型通过 `MODEL_OPTIONS` 配置，profile 使用同名字段：

```json
{
  "reasoningLevels": ["none", "low"],
  "lifecycle": {
    "resourceId": "shared-model-connection",
    "concurrency": 8,
    "unknownLimit": 2,
    "quarantineMs": 60000,
    "firstOutputTimeoutMs": 90000,
    "idleTimeoutMs": 60000
  }
}
```

推理档位必须按供应商实际支持填写；旧 `reasoning` 布尔值不再推导所有档位。未声明时仅支持 none；仅支持 low 的模型应声明 `["low"]`，模块请求也明确选择 low。Pi 的默认首包/停顿上限为 90/60 秒；显式 lifecycle 未填写这两个字段则仅使用总时限。模块可在 `ModelRequest` 单独指定两个上限，无进展能力的非流式引擎会明确拒绝该请求。

单次调用总时限由任务剩余累计执行预算和请求 timeoutMs 共同限制，包含上下文及凭据准备。有效增量只重置停顿计时，不能延长总时限。等待用户输入的任务继续保持原来的持久等待语义，不受模型调用计时器影响。

## 可选 managed-v1 网关协议

只有网关实现并验证下述协议后，才配置 `managed: { "scope": "production" }`。普通 OpenAI 兼容接口不默认具备该协议；现有其他网关私有协议应通过独立适配器映射，不冒充兼容。

Pi 向生成请求添加 `X-Cloud-Agent-Protocol: managed-v1`、`X-Cloud-Agent-Scope`、`X-Cloud-Agent-Request-ID` 和 Unix 毫秒 `X-Cloud-Agent-Deadline`。成功响应必须原样确认 protocol 和 request ID，缺失确认视为失败。控制地址为相同 base URL 下 `GET/DELETE model-requests/:id`，继续使用凭据和 scope，不跟随重定向。

网关契约：按凭据、scope、调用 ID 隔离并去重；取消先到必须留下未启动墓碑；绝对截止贯穿上游；一个调用 ID 最多一次上游生成，禁止内部账号切换重放；多副本共享状态和取消路由；丢失状态返回 unknown。查询/取消返回 `{ "state": "unknown" }` 或协议定义的状态，可带 `usage: { "costUsd": 0.1, "estimated": true, "complete": false }`。transport_closed 不能冒充 not_started 或 completed。

这里交付的是适配器和本地协议验收，不包含生产网关服务。真实供应商是否停止计算、是否停止计费必须由供应商可验证回执证明。

## 运维与验收

取消事务提交后，通过 PostgreSQL NOTIFY 唤醒持有该租约的 Worker；收到提示仍复核数据库，心跳在通知断线时兜底。网页断开仅影响订阅，不取消任务。工作台会提示未知模型调用；任务详情 API 的可选 `modelRequests` 字段只向任务授权主体暴露状态和用量，指标 `cloud_agent_model_requests{state=...}` 按工作区过滤。

本地回归覆盖取消先到、未知状态、迟到回执、跨 Worker 接管、共享容量、推理档位、输出超限和心跳流。真实协议探针使用合成文本且会产生费用，只能由运维显式执行：

```sh
pnpm model:probe --allow-external-call
```

探针检查默认 Pi 配置的一次正常调用和一次取消调用，不使用业务正文、不发邮件。它报告远端状态，不保证供应商停止计费；生产切换前需按实际供应商逐一验证。

升级需先停止旧 Worker、应用追加迁移 030、重新执行运行账号授权，再启动新版本。旧 Worker 不认识隔离账本，禁止混跑或直接回滚旧二进制；失败时暂停执行并向前修复。SDK 为兼容字段增补；内置 text 默认版本升级为 1.1.0，同时保留 1.0.0 定义用于历史任务，模型引擎标识升级后须显式处理旧配置指纹，不自动迁移检查点。

## 可选 Responses 协议

Pi 默认使用 Chat Completions；`MODEL_OPTIONS={"protocol":"responses"}` 或模型配置中的 `protocol` 可选择 Responses。端点沿用供应商实际根地址，不自动补 `/v1`。两条路径共用持久请求、预算、用量和截止机制。适配器标识为 `lifecycle-v2`，升级前排空旧模型任务或保留兼容 Worker。实际网关的协议兼容性需单独联调。

## 包含推理开销的输出额度

Responses 的 `max_output_tokens` 包含可见输出和推理 tokens；参考 [OpenAI Responses 文档](https://developers.openai.com/api/reference/resources/responses/methods/create)。兼容网关可能忽略请求的推理档位或输出上限，不能依据正文短就认定总用量很少。

Pi 现在默认允许模块显式请求最多 8192 tokens，`MODEL_OPTIONS.maxOutputTokens` / 命名 profile 的同名字段可设置模型准入上限（16–131072）。**未显式指定的单次请求仍为 2048**；此改动不自动提高旧模块的调用额度。模块应按供应商的总输出预算设置自己的 `maxOutputTokens`，且不超过模型准入上限。配置的上限是应用约束，不承诺远端供应商实际停止生成或计费。

平台继续拒绝供应商标为输出截断的结果；原有超限检查、Schema 校验及用量记账保留，不截掉推理用量、不自动重发被拒绝结果。显式配置新的模型上限进入模型指纹，修改部署配置前仍须检查在途任务兼容性；未配置该选项的既有引擎标识不变。

`tests/pi-output-budget.test.ts` 使用真实本地 Responses SSE 协议，覆盖短正文加推理用量、扩大额度后的成功、旧请求额度、超出新额度、截断 JSON、配置准入和无隐式重试。
