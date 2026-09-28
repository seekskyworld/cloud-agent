/** 运维显式运行只读业务检查；不发送邮件或进行真实业务交易。 */
import { loadConfig } from "../apps/config.js";
import { createContainer } from "../apps/container.js";
const phase = process.argv[2];
if (phase !== "ready" && phase !== "recovery")
  throw new Error("Usage: pnpm business:check <ready|recovery>");
const container = await createContainer(loadConfig());
try {
  const report = await container.businessChecks.run(phase);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await container.close();
}
