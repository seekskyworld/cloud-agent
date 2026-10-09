// 防止模块删除后旧编译产物继续留在可分发目录。
import { rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
