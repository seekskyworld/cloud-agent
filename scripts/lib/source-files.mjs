/** 发布与扫描共用 Git 候选文件集合；忽略资料不读取，误追踪私有文件则直接拒绝。 */
import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  }).trimEnd();
}
export function publicPath(name) {
  if (
    !name ||
    name.startsWith("/") ||
    /[\r\n\\]/.test(name) ||
    name.split("/").includes("..")
  )
    return false;
  const parts = name.split("/");
  if (
    parts.some((part) =>
      [
        ".git",
        ".golutra",
        "project",
        "node_modules",
        "dist",
        "backups",
        "coverage",
        "test-results",
        "playwright-report",
      ].includes(part),
    )
  )
    return false;
  return !parts.some(
    (part) => part.startsWith(".env") && part !== ".env.example",
  );
}
export async function sourceFiles(root) {
  const names = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  const result = [];
  for (const name of [...new Set(names)].sort()) {
    if (!publicPath(name)) throw new Error(`PRIVATE_SOURCE_PATH: ${name}`);
    let info;
    try {
      info = await lstat(join(root, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) throw new Error(`SOURCE_NOT_REGULAR: ${name}`);
    result.push(name);
  }
  return result;
}
export function cleanRevision(root) {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("RELEASE_REQUIRES_CLEAN_CHECKOUT");
  return git(root, ["rev-parse", "HEAD"]);
}
