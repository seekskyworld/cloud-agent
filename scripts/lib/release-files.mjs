/** 制品清单校验只读取常规文件，拒绝缺失、篡改、路径越界及未列出的附加文件。 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export const digest = (data) => createHash("sha256").update(data).digest("hex");
export async function fileManifest(root, prefix = "") {
  const result = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!prefix && ["release-manifest.json", "SHA256SUMS"].includes(name))
      continue;
    const info = await lstat(join(root, relative));
    if (info.isDirectory())
      Object.assign(result, await fileManifest(root, relative));
    else if (info.isFile())
      result[relative] = digest(await readFile(join(root, relative)));
    else throw new Error(`RELEASE_NOT_REGULAR: ${relative}`);
  }
  return result;
}
export async function verifyRelease(root) {
  for (const name of ["release-manifest.json", "SHA256SUMS"]) {
    if (!(await lstat(join(root, name))).isFile())
      throw new Error("RELEASE_NOT_REGULAR");
  }
  const raw = await readFile(join(root, "release-manifest.json"), "utf8"),
    manifest = JSON.parse(raw);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "cloud-agent-source-sdk" ||
    !/^[a-f0-9]{40,64}$/.test(manifest.revision)
  )
    throw new Error("RELEASE_MANIFEST_INVALID");
  const actual = await fileManifest(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("RELEASE_CONTENT_CHANGED");
  if (digest(JSON.stringify(actual)) !== manifest.fingerprint)
    throw new Error("RELEASE_FINGERPRINT_INVALID");
  const sums = [
    ...Object.entries(actual),
    ["release-manifest.json", digest(raw)],
  ]
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join("");
  if ((await readFile(join(root, "SHA256SUMS"), "utf8")) !== sums)
    throw new Error("RELEASE_CHECKSUMS_INVALID");
  return manifest;
}
