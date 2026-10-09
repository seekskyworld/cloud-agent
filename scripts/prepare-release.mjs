/** 从干净源码构建候选包，不发布、不推送；产物含来源、锁文件摘要及独立校验清单。 */
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sourceFiles, cleanRevision } from "./lib/source-files.mjs";
import { digest, fileManifest, verifyRelease } from "./lib/release-files.mjs";
const root = resolve("."),
  target = resolve("dist/release"),
  revision = cleanRevision(root);
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
// 构建会清空 dist；所有共享生成目录的命令按顺序执行。
run("pnpm", ["secrets:check"]);
run("pnpm", ["build"]);
run("pnpm", ["sdk:verify"]);
run("pnpm", ["contracts:check"]);
run("pnpm", ["sbom"]);
if (cleanRevision(root) !== revision) throw new Error("RELEASE_SOURCE_CHANGED");
const temporary = await mkdtemp(join(tmpdir(), "cloud-agent-release-"));
try {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const names = await sourceFiles(root);
  for (const name of names) {
    await mkdir(dirname(join(temporary, name)), { recursive: true });
    await copyFile(join(root, name), join(temporary, name));
    await chmod(
      join(temporary, name),
      (await lstat(join(root, name))).mode & 0o111 ? 0o755 : 0o644,
    );
  }
  await mkdir(target);
  run("tar", [
    "-czf",
    join(target, `cloud-agent-${pkg.version}-source.tar.gz`),
    "-C",
    temporary,
    ".",
  ]);
  run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", target],
    resolve("dist/sdk-package"),
  );
  await copyFile("test-results/sbom.cdx.json", join(target, "sbom.cdx.json"));
  await writeFile(
    join(target, "README.txt"),
    `Cloud Agent ${pkg.version}\nSource revision: ${revision}\n\nVerify SHA256SUMS before extracting. Checksums are not signatures.\nThe source archive includes the lockfile, Dockerfile and quick start.\nThe SDK tarball installs with npm install <tarball>. It is not published to npm.\nBuild local images from source; no image or hosted service is included.\nFull test results belong to the matching CI run; preparation alone is not a production-readiness certification.\n`,
  );
  const files = await fileManifest(target);
  const manifest = {
    schemaVersion: 1,
    kind: "cloud-agent-source-sdk",
    version: pkg.version,
    revision,
    lockDigest: digest(await readFile("pnpm-lock.yaml")),
    fingerprint: digest(JSON.stringify(files)),
    files,
  };
  const raw = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(join(target, "release-manifest.json"), raw);
  await writeFile(
    join(target, "SHA256SUMS"),
    [...Object.entries(files), ["release-manifest.json", digest(raw)]]
      .map(([name, hash]) => `${hash}  ${name}\n`)
      .join(""),
  );
  if (cleanRevision(root) !== revision)
    throw new Error("RELEASE_SOURCE_CHANGED");
  await verifyRelease(target);
  process.stdout.write(
    `Prepared local release candidate: dist/release (${manifest.fingerprint})\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
