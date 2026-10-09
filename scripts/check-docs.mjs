/** 覆盖所有可交付 Markdown；校验本地文件、标题锚点与公开边界，阻止接入指南静默失效。 */
import { readFile, stat, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceFiles, publicPath } from "./lib/source-files.mjs";

function prose(source) {
  let fence;
  const lines = [];
  for (const line of source.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (fence && marker?.[0] === fence[0] && marker.length >= fence.length)
      fence = undefined;
    else if (!fence) lines.push(line);
  }
  if (fence) throw new Error("UNCLOSED_CODE_FENCE");
  return lines.join("\n");
}
export function headingAnchors(source) {
  const counts = new Map(),
    anchors = new Set();
  for (const match of prose(source).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1]
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .trim()
      .replace(/ /g, "-");
    let slug = base,
      suffix = counts.get(base) ?? 0;
    while (anchors.has(slug)) slug = `${base}-${++suffix}`;
    counts.set(base, suffix);
    anchors.add(slug);
  }
  for (const match of source.matchAll(
    /<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/g,
  ))
    anchors.add(match[1]);
  return anchors;
}
function links(source) {
  const text = prose(source),
    targets = [];
  for (const pattern of [
    /\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g,
    /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
    /<(?:a|img)\b[^>]*(?:href|src)=["']([^"']+)["']/g,
  ])
    for (const match of text.matchAll(pattern)) targets.push(match[1]);
  return targets;
}
export async function checkDocuments(root, files) {
  const errors = [],
    known = new Set(files),
    realRoot = await realpath(root);
  for (const file of files.filter((name) => name.endsWith(".md"))) {
    try {
      const content = await readFile(resolve(root, file), "utf8");
      if (/\/Users\/[^/]+\/|[A-Z]:\\Users\\/.test(content))
        throw new Error("LOCAL_PATH_IN_PUBLIC_DOCS");
      for (const target of links(content)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        const [rawPath, fragment] = target.split("#"),
          path = rawPath
            ? resolve(dirname(resolve(root, file)), decodeURIComponent(rawPath))
            : resolve(root, file);
        const local = relative(root, path).split("\\").join("/");
        if (!publicPath(local))
          throw new Error(`PRIVATE_OR_EXTERNAL_TARGET: ${target}`);
        const real = await realpath(path);
        if (relative(realRoot, real).startsWith(".."))
          throw new Error(`LINK_ESCAPES_REPOSITORY: ${target}`);
        if ((await stat(path)).isFile() && !known.has(local))
          throw new Error(`UNPUBLISHED_TARGET: ${target}`);
        if (
          fragment &&
          path.endsWith(".md") &&
          !headingAnchors(await readFile(path, "utf8")).has(
            decodeURIComponent(fragment),
          )
        )
          throw new Error(`MISSING_HEADING: ${target}`);
      }
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve("."),
    files = await sourceFiles(root);
  await checkDocuments(root, files);
  process.stdout.write(
    `Public documentation and anchors passed: ${files.filter((f) => f.endsWith(".md")).length} files\n`,
  );
}
