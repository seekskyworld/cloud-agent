// 只收集 SDK 公共入口的编译闭包，发布包不依赖宿主源码目录。
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
const root = resolve("dist"),
  target = resolve("dist/sdk-package");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const seen = new Set();
async function copyModule(path) {
  path = resolve(path);
  if (seen.has(path)) return;
  if (!path.startsWith(root + "/")) throw new Error("SDK_DEPENDENCY_ESCAPED");
  seen.add(path);
  const source = await readFile(path, "utf8"),
    destination = resolve(target, relative(root, path));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source);
  for (const match of source.matchAll(
    /(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g,
  )) {
    const next = resolve(dirname(path), match[1]);
    await copyModule(
      path.endsWith(".d.ts") ? next.replace(/\.js$/, ".d.ts") : next,
    );
  }
}
for (const entry of [
  "packages/sdk/index",
  "packages/api/client",
  "packages/ui/index",
  "packages/connectors/index",
  "packages/testing/index",
])
  for (const extension of [".js", ".d.ts"])
    await copyModule(resolve(root, entry + extension));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  resolve(target, "package.json"),
  JSON.stringify(
    {
      name: "@cloud-agent/sdk",
      version: pkg.version,
      type: "module",
      license: "Apache-2.0",
      engines: pkg.engines,
      files: ["packages", "LICENSE", "NOTICE", "README.md"],
      exports: {
        ".": {
          types: "./packages/sdk/index.d.ts",
          default: "./packages/sdk/index.js",
        },
        "./client": {
          types: "./packages/api/client.d.ts",
          default: "./packages/api/client.js",
        },
        "./connectors": {
          types: "./packages/connectors/index.d.ts",
          default: "./packages/connectors/index.js",
        },
        "./testing": {
          types: "./packages/testing/index.d.ts",
          default: "./packages/testing/index.js",
        },
        "./ui": {
          types: "./packages/ui/index.d.ts",
          default: "./packages/ui/index.js",
        },
      },
      dependencies: {
        zod: pkg.dependencies.zod,
        "@types/node": pkg.devDependencies["@types/node"],
      },
      peerDependencies: { react: ">=19", "@types/react": ">=19" },
      peerDependenciesMeta: {
        react: { optional: true },
        "@types/react": { optional: true },
      },
    },
    null,
    2,
  ) + "\n",
);
await copyFile("LICENSE", resolve(target, "LICENSE"));
await copyFile("NOTICE", resolve(target, "NOTICE"));
await copyFile("packages/sdk/README.md", resolve(target, "README.md"));
process.stdout.write(`SDK artifact prepared: ${seen.size} compiled files\n`);
