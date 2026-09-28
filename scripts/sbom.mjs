// CycloneDX 1.5 的组件与依赖图来自实际安装的锁定生产依赖，不输出安装路径。
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const [tree] = JSON.parse(
  execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  }),
);
const pkg = JSON.parse(await readFile("package.json", "utf8")),
  components = new Map(),
  dependencies = new Map();
function walk(name, node) {
  const ref = `pkg:npm/${name.replace("@", "%40")}@${node.version}`;
  if (components.has(ref)) return ref;
  components.set(ref, {
    type: "library",
    name,
    version: node.version,
    purl: ref,
    "bom-ref": ref,
  });
  dependencies.set(ref, {
    ref,
    dependsOn: Object.entries(node.dependencies ?? {}).map(([n, d]) =>
      walk(n, d),
    ),
  });
  return ref;
}
const roots = Object.entries(tree.dependencies ?? {}).map(([n, d]) =>
  walk(n, d),
);
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/sbom.cdx.json",
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: `urn:uuid:${randomUUID()}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: {
          type: "application",
          name: pkg.name,
          version: pkg.version,
          "bom-ref": "cloud-agent",
        },
      },
      components: [...components.values()],
      dependencies: [
        { ref: "cloud-agent", dependsOn: roots },
        ...dependencies.values(),
      ],
    },
    null,
    2,
  ),
);
process.stdout.write(`SBOM generated: ${components.size} components\n`);
