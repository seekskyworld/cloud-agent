/** 交付边界测试使用新建仓库和合成内容，覆盖误追踪、脏工作区与制品篡改。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, sourceFiles, cleanRevision } from "./lib/source-files.mjs";
import { digest, fileManifest, verifyRelease } from "./lib/release-files.mjs";
import { checkDocuments, headingAnchors } from "./check-docs.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cloud-agent-tooling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("source selection excludes ignored references and rejects forced private files and links", async (t) => {
  const root = await fixture(t);
  git(root, ["init"]);
  await writeFile(join(root, ".gitignore"), "project/\n.env\n");
  await writeFile(join(root, ".env"), "synthetic-private-config");
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project/reference.txt"), "synthetic-reference");
  await writeFile(join(root, "README.md"), "# public\n");
  assert.deepEqual(await sourceFiles(root), [".gitignore", "README.md"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  assert.match(cleanRevision(root), /^[0-9a-f]{40}$/);
  await writeFile(join(root, "README.md"), "changed");
  assert.throws(() => cleanRevision(root), /CLEAN_CHECKOUT/);
  git(root, ["add", "-f", ".env"]);
  await assert.rejects(sourceFiles(root), /PRIVATE_SOURCE_PATH/);
  git(root, ["rm", "--cached", ".env"]);
  await symlink("README.md", join(root, "linked.md"));
  await assert.rejects(sourceFiles(root), /SOURCE_NOT_REGULAR/);
});
test("release verification detects tampering, unexpected files and symlinks", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "source.tgz"), "synthetic-archive");
  const files = await fileManifest(root);
  const raw = JSON.stringify({
    schemaVersion: 1,
    kind: "cloud-agent-source-sdk",
    revision: "a".repeat(40),
    fingerprint: digest(JSON.stringify(files)),
    files,
  });
  await writeFile(join(root, "release-manifest.json"), raw);
  const sums = [
    ...Object.entries(files),
    ["release-manifest.json", digest(raw)],
  ]
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join("");
  await writeFile(join(root, "SHA256SUMS"), sums);
  await verifyRelease(root);
  await writeFile(join(root, "source.tgz"), "tampered");
  await assert.rejects(verifyRelease(root), /CONTENT_CHANGED/);
  await writeFile(join(root, "source.tgz"), "synthetic-archive");
  await writeFile(join(root, "extra.txt"), "unexpected");
  await assert.rejects(verifyRelease(root), /CONTENT_CHANGED/);
  await rm(join(root, "extra.txt"));
  await writeFile(join(root, "SHA256SUMS"), "tampered");
  await assert.rejects(verifyRelease(root), /CHECKSUMS_INVALID/);
  await writeFile(join(root, "SHA256SUMS"), sums);
  await rm(join(root, "source.tgz"));
  await symlink("release-manifest.json", join(root, "source.tgz"));
  await assert.rejects(verifyRelease(root), /NOT_REGULAR/);
});
test("recursive document targets validate anchors, private paths and ignored files", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "README.md"),
    "# Start\n[Guide](docs/guide.md#开始-1)\n",
  );
  await writeFile(
    join(root, "docs/guide.md"),
    "# 开始\n# 开始\n[Back](../README.md#start)\n",
  );
  const files = ["README.md", "docs/guide.md"];
  await checkDocuments(root, files);
  assert.deepEqual(
    [...headingAnchors("# Hello_world\n# Hello_world\n")],
    ["hello_world", "hello_world-1"],
  );
  await writeFile(
    join(root, "docs/guide.md"),
    "# 开始\n[Invalid](../README.md#missing)\n",
  );
  await assert.rejects(checkDocuments(root, files), /MISSING_HEADING/);
  await writeFile(join(root, "README.md"), "[Secret](.env)\n");
  await assert.rejects(checkDocuments(root, files), /PRIVATE_OR_EXTERNAL/);
  await writeFile(join(root, "README.md"), "[Escape](../outside.md)\n");
  await assert.rejects(checkDocuments(root, files), /PRIVATE_OR_EXTERNAL/);
  await writeFile(join(root, "README.md"), "[Hidden](hidden.md)\n");
  await writeFile(join(root, "hidden.md"), "not-published");
  await assert.rejects(checkDocuments(root, files), /UNPUBLISHED_TARGET/);
});
