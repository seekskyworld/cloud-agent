/** 显式本机诊断；不连接数据库、供应商或对象存储。 */
import { loadConfig } from "../apps/config.js";
import { diagnose } from "../apps/doctor.js";
try {
  const report = await diagnose(loadConfig());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
} catch {
  process.stderr.write("CONFIG_INVALID\n");
  process.exitCode = 1;
}
