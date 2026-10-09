// 浏览器静态产物也随附框架和依赖授权声明，单独分发网页时保留这些文件。
import { copyFile } from "node:fs/promises";
for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"])
  await copyFile(name, `dist/web/${name}`);
