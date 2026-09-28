// 只生成新的本地演示配置，不覆盖已有设置或把随机凭据输出到终端。
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const secret = () => randomBytes(24).toString("hex");
const content = `# 本地演示环境；凭据仅用于此部署，请勿提交此文件。\nPOSTGRES_PASSWORD=${secret()}\nRUNTIME_PASSWORD=${secret()}\nAUTH_MODE=none\nAPI_PORT=3100\nMODEL_MODE=demo\n`;
await writeFile(".env", content, { flag: "wx", mode: 0o600 });
process.stdout.write(
  "Created .env with private permissions; existing files are never overwritten.\n",
);
