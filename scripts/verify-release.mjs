/** 完整性检查不替代签名或可信下载渠道；只验证交付目录，不解包或执行其中源码。 */
import { resolve } from "node:path";
import { verifyRelease } from "./lib/release-files.mjs";
const manifest = await verifyRelease(
  resolve(process.argv[2] ?? "dist/release"),
);
process.stdout.write(
  `Release ${manifest.version} verified: ${manifest.fingerprint}\n`,
);
