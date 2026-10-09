# 开发与验证

参考环境：Node.js 24 LTS、pnpm 10.6.1、Docker Compose。未安装 pnpm 时执行 `npm install -g pnpm@10.6.1`。

## 本地热更新

若完整 Compose 占用 3100，先 `docker compose stop api worker`，然后安装依赖、启动独立开发库：

```sh
pnpm install --frozen-lockfile
docker compose -p cloud-agent-dev -f compose.dev.yaml up -d --wait
```

在根目录 `.env` 配置以下项，保留原有 Compose 密码：

```dotenv
DATABASE_URL=postgres://cloud_agent_dev:local-dev-only@127.0.0.1:55432/cloud_agent_dev
AUTH_MODE=none
MODEL_MODE=demo
LOCAL_WORKSPACE=default
LOCAL_PRINCIPAL=owner
HOST=127.0.0.1
PORT=3100
```

运行 `pnpm migrate`、`pnpm bootstrap`，再分别在三个终端启动 `pnpm dev:api`、`pnpm dev:worker`、`pnpm dev:web`。打开 <http://localhost:5173>；代理默认指向 3100，换端口时用 `WEB_API_URL=http://127.0.0.1:新端口 pnpm dev:web`。

开发库使用独立卷和 owner 连接；正式 API/Worker 使用受限数据库角色。

## 验证

仅改文档运行 `pnpm docs:check` 和 `git diff --check`。代码验证先启动隔离测试库，再按范围执行：

```sh
docker compose -p cloud-agent-test -f compose.test.yaml up -d --wait
pnpm format:check
pnpm licenses:check
pnpm check
# 涉及页面
pnpm exec playwright install chromium
pnpm test:browser
# 涉及部署、迁移或授权存储
docker build -t cloud-agent:local .
pnpm test:compose
```

`pnpm check` 包含文档、类型、lint、依赖方向、后端测试、核心覆盖率、交付工具回归和构建。单独跑后端用 `pnpm test:integration`；底层 `pnpm test` 需要运行器准备的临时库环境。核心 `packages/**` 行/分支/函数门槛各 80%，不代表整仓覆盖率。

测试库端口 55439，每次创建随机临时数据库并清理；`TEST_ADMIN_DATABASE_URL` 需创建库权限，库名含 `_test`，默认指向 `127.0.0.1:55439/cloud_agent_test`。`TEST_DATABASE_URL` 由运行器生成，勿指向用户库。浏览器截图在 `test-results/`；Compose 验证使用独立项目，覆盖重启、受限角色及备份恢复。

测试入口：`tests/runtime.test.ts`（恢复/副作用）、`api.test.ts`（路由/隔离）、`administration.test.ts`（角色/审计）、`adapters.test.ts`（受控外部协议）、`mail.test.ts`（邮件/投递）、`refactoring.test.ts`（服务/版本/生成器/归档/升级）、`browser/`（桌面/手机）。替身仅放 `tests/fixtures/`。`scripts/boundaries.test.mjs` 验证生产源码不能导入测试夹具、本地参考项目或由核心直连模型 SDK；静态导入、重导出、类型引用及字面量动态导入均受检查。新增模型 SDK 时同步更新边界规则；非字面量动态加载不属于此静态检查的证明范围，生产扩展仍必须静态注册。

完成后用 `docker compose -p cloud-agent-test -f compose.test.yaml down` 清理测试容器，`docker compose -p cloud-agent-dev -f compose.dev.yaml stop` 停止开发库。

## 分发与验收范围

依赖变化运行 `pnpm licenses:generate`，提交锁文件和第三方声明。构建会清理 `dist/`，并把 LICENSE、NOTICE 和第三方许可复制到网页与镜像；不要在生成目录手工保存源码。构建、SDK 打包和依赖 `dist/` 的浏览器验证按顺序执行。

验收结果随对应提交的 CI 或交付记录保存，注明环境、执行命令、失败项及未验证范围。文档不维护随代码过期的测试数量和覆盖率快照；本地测试、托管 CI、制品发布和真实供应商联调分别记录，不能互相替代。

业务接入按实际使用能力选择验收路径，例如人工确认后执行，或连接读取 → 模型 → 文件交付。已有 `tests/tutorial.test.ts`、`tests/fixtures/pipeline-package.ts` 和 `tests/evolution-adapters.test.ts` 提供隔离协议验证，不能当作真实业务采用的证明。接入方应从干净源码或 SDK 制品运行自己的场景，验证撤权、超时、取消、重启恢复与升级，记录来源版本、修改文件、是否修改核心、首任务耗时及阻塞点。

源码开发使用 `tsx --conditions=development`，生产从 `dist/` 加载；公开 SDK 入口及独立工程步骤见 [仓库外扩展](external-extensions.md)。生成业务包的 `contract.test.ts` 应加入业务 CI，后端与页面清单分别验证。真实模型、邮箱和存储使用隔离账号联调，诊断中的 `unchecked` 不代表连通性通过。

开发约定见 [AGENTS](../AGENTS.md)，提交要求见 [贡献指南](../CONTRIBUTING.md)，功能与兼容变化集中在 [CHANGELOG](../CHANGELOG.md)。

## SDK、兼容和供应链

```sh
pnpm sdk:build
pnpm sdk:verify
pnpm contracts:check
pnpm evaluate
pnpm supply-chain:check
pnpm sbom
pnpm test:recovery
pnpm benchmark
```

兼容基线在 `tests/contracts/public-v1.json`，包括公开 OpenAPI 和 SDK 声明闭包。门禁保守拒绝既有端点/类型变化，连兼容 Schema 增补也需审阅；确认兼容窗口后才运行 `pnpm contracts:update` 并在 PR 解释，不可自动更新基线绕过检查。新端点与依赖声明需要同时更新客户端、文档和验收。旧客户端创建、重放、事件和下载的实际行为由 `api-contracts.test.ts` 保证。

`tests/evaluations/baseline.json` 为无网络、无真实副作用的版本化编排基线，记录输入、预期动作/工具、成本与延迟上限。`pnpm evaluate` 输出差异结果到 `test-results/evaluation.json`；业务接入时补自己的脱敏案例和纯回放器。基础案例只能评估编排协议，不证明真实模型的业务质量。负载报告为 `test-results/capacity.json`，只使用受控模型延迟，不能作为生产 SLA。

供应链门禁检查生产依赖 high/critical 公告；CycloneDX SBOM 与 SDK 制品由 CI 存档。镜像本地构建后用 `docker image inspect cloud-agent:local --format '{{.Id}}'` 记录内容 ID，正式发布应固定仓库 digest，不部署浮动标签。更新依赖后必须重生许可并验证邮件 TLS/DKIM、HTTP、镜像；没有在此流程中自动发布 npm 或镜像。

支持矩阵集中见 [SUPPORT.md](../SUPPORT.md)，维护及协议决策见 [GOVERNANCE.md](../GOVERNANCE.md)。

发布前：完成上述门禁 → 复核迁移/兼容变更 → 更新 CHANGELOG 与版本 → 保存 SDK 包、SBOM、镜像摘要 → 维护者显式发布。根应用保持 private，独立 SDK 包由构建脚本生成。制品版本与根 package.json 一致。

## 候选交付包

准备 Gitleaks 8.30.1 或更新版本。`pnpm secrets:check` 只扫描 Git 当前可交付文件（含未忽略的新文件），不读取 `.env`、参考项目和本机协作资料；误追踪私有路径会失败，报告只包含规则及位置。Git 历史审计是首次公开前的独立工作。

在已提交、工作区干净且完成相应验收的源码中执行：

```sh
pnpm release:prepare
pnpm release:verify
```

`release:prepare` 顺序执行秘密扫描、全新构建、SDK 独立安装验证、契约检查和 SBOM 生成，写入 `dist/release/`：源码 tar.gz、SDK tgz、SBOM、来源清单与 `SHA256SUMS`。构建会清空旧 dist；需要保留的历史候选包先移到其他目录。它不运行完整后端/容器验收，也不推送或发布；发布者需保留同一提交对应的 CI 验收记录。

接收方在解压前先用可信渠道取得的校验清单验证，例如 `shasum -a 256 -c SHA256SUMS`。从源码 checkout 可用 `pnpm release:verify /候选目录` 验证完整目录，缺失、附加、篡改文件及符号链接都会被拒绝。校验和不是签名，不能证明下载源身份。源码包含锁文件和 Dockerfile，可按 README 本地构建；从源码归档开发时先 `git init` 并提交导入快照（归档不含 Git 历史，文件集合检查需要仓库），原始来源提交保存在外层清单；候选包不包含预构建镜像、真实配置、数据库或业务数据。

CI 固定 Action 提交、设置超时和并发控制，失败时保存 SDK 验证与浏览器诊断；每周复跑依赖/秘密扫描。手动触发 check 工作流并启用 `prepare_release` 后，只有 check/security 成功才生成候选包 artifact，权限仅为 contents:read，不创建 GitHub Release。托管保护规则及私密报告入口由维护者配置，见 GOVERNANCE。
