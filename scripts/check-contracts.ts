/** 保守的兼容门禁：既有端点和声明文件的改变必须显式审阅更新基线。新增入口允许。 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { format, resolveConfig } from "prettier";
import { openapi } from "../packages/api/openapi.js";
const api = openapi("token"),
  declarations: Record<string, string> = {};
async function scan(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (path.endsWith(".d.ts"))
      declarations[path.replace("dist/sdk-package/", "")] = await readFile(
        path,
        "utf8",
      );
  }
}
await scan("dist/sdk-package/packages");
const snapshot = { api, declarations },
  path = "tests/contracts/public-v1.json";
if (process.argv.includes("--write")) {
  await mkdir("tests/contracts", { recursive: true });
  await writeFile(
    path,
    await format(JSON.stringify(snapshot, null, 2), {
      ...(await resolveConfig(path)),
      filepath: path,
    }),
  );
} else {
  const baseline = JSON.parse(await readFile(path, "utf8")) as typeof snapshot;
  for (const [route, methods] of Object.entries(baseline.api.paths))
    for (const [method, contract] of Object.entries(methods))
      if (!isDeepStrictEqual(contract, api.paths[route]?.[method]))
        throw new Error(`API_CONTRACT_CHANGED: ${method} ${route}`);
  if (!isDeepStrictEqual(baseline.api.components, api.components))
    throw new Error(
      "API_SCHEMA_CHANGED: review compatibility before updating baseline",
    );
  for (const [file, source] of Object.entries(baseline.declarations))
    if (declarations[file] !== source)
      throw new Error(`SDK_DECLARATION_CHANGED: ${file}`);
  process.stdout.write("API and SDK compatibility baseline passed\n");
}
