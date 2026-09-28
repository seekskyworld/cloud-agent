/** 在临时目录扫描可交付源码；只报告位置，不打印命中的秘密或读取忽略文件。 */
import { mkdtemp, mkdir, copyFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sourceFiles } from "./lib/source-files.mjs";
const root = resolve("."),
  directory = await mkdtemp(join(tmpdir(), "cloud-agent-secrets-"));
try {
  const source = join(directory, "source"),
    report = join(directory, "findings.json");
  await mkdir(source);
  for (const name of await sourceFiles(root)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await copyFile(join(root, name), join(source, name));
  }
  try {
    execFileSync(
      "gitleaks",
      [
        "dir",
        source,
        "--redact",
        "--no-banner",
        "--ignore-gitleaks-allow",
        "--report-format",
        "json",
        "--report-path",
        report,
      ],
      { stdio: "pipe" },
    );
    process.stdout.write(
      "Publishable source secret scan passed (Git history excluded)\n",
    );
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("GITLEAKS_REQUIRED: install Gitleaks 8.30.1 or newer");
    const findings = JSON.parse(
      await readFile(report, "utf8").catch(() => "[]"),
    );
    for (const finding of findings)
      process.stderr.write(
        `${finding.RuleID}: ${finding.File.replace(source + "/", "")}:${finding.StartLine}\n`,
      );
    throw new Error("SECRET_SCAN_FAILED");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
