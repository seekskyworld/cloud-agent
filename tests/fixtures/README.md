# 测试夹具

这里只存放隔离验证用的替身与协议样本，不注册到默认业务清单，也不由生产入口导入。

- `records-package.ts` / `records-store.ts`：验证独立迁移、领域端口、版本与幂等、受保护路由、页面声明和持久作业。
- `pipeline-package.ts`：验证连接、模型、上下文和文件端口组合，只访问测试 HTTP 服务。
- `compensation.ts`：验证子任务失败收集、人工确认及补偿工具去重，不定义实际资源回滚。

SDK 验收将前两个测试包复制到临时外部工程，只依赖打包后的 SDK 和第三方库。接入自己的业务请使用 `pnpm package:create` 和 `docs/extending.md`；不要依赖这些测试夹具。
