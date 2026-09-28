# 身份与权限

工作区范围、管理角色、显式业务能力和领域 ACL 共同生效。角色限定工作区，没有跨租户通配管理员。

| 角色 | 管理权限 | 业务权限 |
| --- | --- | --- |
| `member` | 无成员目录或授权审计权限 | 仅显式能力 |
| `admin` | `identity:read`、`audit:read` | 仍需能力，不能给自己或他人提权 |
| `superadmin` | 上述权限及 `identity:manage` | 不绕过所有者、资源 ACL 或工具确认 |

管理权限由角色推导，经 `/v1/me.administration` 返回，不能写进 capabilities 伪装提权。业务能力目录来自注册模块，当前含 `report:run`、`text:run`；平台另有 `schedule:write`、`task:signal`、`operations:read`、`mail:use`。

## 页面与 API

管理员可见“权限管理”；超级管理员可配置 member/admin、能力和启停状态，必须填写原因。受保护超级管理员只能通过可信命令配置。

| API | 行为 |
| --- | --- |
| `GET /v1/admin/catalog` | 角色和动态能力目录 |
| `GET /v1/admin/principals?offset=0` | 工作区成员，每页 100 条，无 Token 摘要 |
| `GET /v1/admin/audit?before=<id>` | 授权记录，ID 倒序，最多 100 条 |
| `POST /v1/admin/principals` | 新建/修改 member/admin，需 `Idempotency-Key` |

请求示例：

```json
{"id":"operator","role":"admin","capabilities":["report:run"],"enabled":true,"expectedVersion":null,"reason":"授予报告及目录查看权限"}
```

新建用 `expectedVersion:null`，编辑用列表中的 `access_version`。并发版本冲突返回 `409 ACCESS_VERSION_CONFLICT`；同键异参返回 `409 IDEMPOTENCY_CONFLICT`。旧请求重放只返回原回执，不恢复后续已撤销的权限，需重新查询当前状态。

## 登录与执行边界

默认模式所有浏览器共享 `LOCAL_WORKSPACE/LOCAL_PRINCIPAL`。新增成员只创建身份和权限，不提供登录或签发 Token；多人使用须接可信身份提供方或 [Token 配置](operations.md#配置)，不能用客户端身份 ID 模拟登录。

API、Worker 和工具均复核身份。运行数据库角色不能直接写身份/审计/管理命令表；`manage_principal_access` 锁定并复核操作者、版本及受保护身份，原子保存授权与审计，固定 search_path 且不对 PUBLIC 开放。它依赖可信后端传入操作者，不支持用户直连数据库。停用不删除历史，撤权不撤销已发生的远端动作；领域 ACL 由模块和外部系统判定。

## 可信配置

bootstrap 仅为新建初始身份授予 superadmin 和默认能力，重启不提权、不覆盖已有能力、不恢复禁用身份。为已有启用身份初始化管理员：

```sh
docker compose run --rm migrate node dist/scripts/bootstrap-admin.js \
  --workspace default --principal owner --reason "初始化工作区管理员"
```

更新受保护身份能力：

```sh
docker compose run --rm migrate node dist/scripts/bootstrap-admin.js \
  --workspace default --principal owner --reason "更新已安装模块能力" \
  --capabilities 'report:run,text:run,schedule:write,task:signal,operations:read,mail:use'
```

**该参数替换整个集合**；省略保留原能力，空字符串清空。相同配置不重复审计；命令只处理已有且启用的身份。宿主也可用 `pnpm bootstrap:admin`，通过 `MIGRATION_DATABASE_URL` 或运维 `DATABASE_URL` 连接。


企业认证可通过 OIDC IdentityProvider 映射预登记主体，附加 Token 支持期限与撤销，默认免 Token 不变。任务所有者可显式授予同工作区成员短期读取/审批委托；受托能力是双方当前能力的交集，仍检查任务、领域和上下文权限。管理角色不自动获得委托或业务操作权。接口见 [API](api.md#治理与协作接口)，配置见 [运维](operations.md#修订运行治理与恢复)。
