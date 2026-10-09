// 从 npm tarball 验证公共类型和运行入口，临时工程不链接任何平台源码。
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), "cloud-agent-sdk-"));
try {
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--pack-destination", directory],
    { cwd: resolve("dist/sdk-package") },
  );
  const [{ filename }] = JSON.parse(stdout);
  const root = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      join(directory, filename),
      `typescript@${root.devDependencies.typescript}`,
    ],
    { cwd: directory },
  );
  for (const file of ["records-package.ts", "pipeline-package.ts"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(
      join(directory, file),
      (await readFile(join("tests/fixtures", file), "utf8")).replaceAll(
        '"cloud-agent/sdk"',
        '"@cloud-agent/sdk"',
      ),
    );
  }
  await writeFile(
    join(directory, "verify.ts"),
    `import { recordsPackage } from "./records-package.js"; import { pipelinePackage } from "./pipeline-package.js"; if (recordsPackage.id!=="fixture-records" || pipelinePackage.id!=="fixture-pipeline") throw Error("BUSINESS_PACKAGE_FAILURE"); import { defineBusinessPackage } from '@cloud-agent/sdk'; import { CloudAgentClient } from '@cloud-agent/sdk/client'; import { canSend, type ArtifactStore, type ChannelProvider } from '@cloud-agent/sdk/connectors'; import { verifyMailSendContract } from '@cloud-agent/sdk/testing'; if(!canSend({mode:'send',send:async()=> 'id'})) throw Error('CONNECTOR_FAILURE'); await verifyMailSendContract({send:async()=> 'id'},{id:'id',recipient:'test@example.test',subject:'fixture',body:'fixture',replyTo:'fixture'}); const acceptsStore = (_store: ArtifactStore | ChannelProvider) => {}; void acceptsStore; import { z } from 'zod'; const pkg=defineBusinessPackage({id:'external',version:'1.0.0',sdkMajor:1,permissions:[],requires:{},config:z.object({}),create:()=>({modules:[]})}); if(pkg.id!=='external'||typeof CloudAgentClient!=='function') throw Error('SDK_FAILURE');`,
  );
  await run(
    join(directory, "node_modules/.bin/tsc"),
    [
      "--strict",
      "--skipLibCheck",
      "false",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "verify.ts",
    ],
    { cwd: directory },
  );
  await run(process.execPath, ["verify.js"], { cwd: directory });
  // 后端先在无 React 的安装中验证，UI 使用者随后显式安装可选 peer。
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `react@${root.dependencies.react}`,
      `@types/react@${root.devDependencies["@types/react"]}`,
    ],
    { cwd: directory },
  );
  await writeFile(
    join(directory, "ui.ts"),
    `import { defineBusinessViews, type BusinessView } from '@cloud-agent/sdk/ui'; const views: BusinessView[] = []; defineBusinessViews(views);`,
  );
  await run(
    join(directory, "node_modules/.bin/tsc"),
    [
      "--strict",
      "--skipLibCheck",
      "false",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "ui.ts",
    ],
    { cwd: directory },
  );
  await run(process.execPath, ["ui.js"], { cwd: directory });
  // 实际运行仓库外模板：每个工程独立安装 tarball，不链接本仓源码或 node_modules。
  for (const kind of ["business", "mail"]) {
    const external = join(directory, `external-${kind}`);
    await run(process.execPath, [
      resolve("scripts/create-external.mjs"),
      kind,
      `external-${kind}`,
      external,
      join(directory, filename),
    ]);
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=optional",
      ],
      { cwd: external },
    );
    await run("npm", ["test"], { cwd: external });
  }
  process.stdout.write("Published SDK tarball types/runtime passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
