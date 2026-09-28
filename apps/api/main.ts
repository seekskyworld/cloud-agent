/** API 与 Worker 独立进程启动，迁移由发布步骤显式执行。 */
import { loadConfig } from "../config.js";
import { createApplication } from "../application.js";
import { createApp } from "./app.js";
const container = await createApplication(loadConfig());
const app = await createApp(container);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => container.close());
  });
await app.listen({ host: container.config.HOST, port: container.config.PORT });
