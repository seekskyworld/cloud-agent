/** 运维显式运行只读业务检查；不发送邮件或进行真实业务交易。 */
import { loadConfig } from "../apps/config.js";
import { createApplication } from "../apps/application.js";
const phase = process.argv[2];
if (phase !== "ready" && phase !== "recovery" && phase !== "retirement")
  throw new Error("Usage: pnpm business:check <ready|recovery|retirement>");
const container = await createApplication(loadConfig());
try {
  const report = await container.businessChecks.run(phase);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await container.close();
}
