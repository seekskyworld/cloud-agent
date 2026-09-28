/** 静态配置的审阅/修订/切换入口，使用操作员显式指定的当前修订防止覆盖并发发布。 */
import "dotenv/config";
import { createContainer } from "../apps/container.js";
import { loadConfig } from "../apps/config.js";
import {
  Deployments,
  deploymentDiff,
  revisionId,
} from "../packages/deployment/index.js";
const [operation = "plan", expected, reason] = process.argv.slice(2);
if (!["plan", "stage", "activate"].includes(operation))
  throw new Error("DEPLOYMENT_COMMAND_INVALID");
const config = loadConfig();
if (operation !== "plan") {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
  config.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}
const c = await createContainer(config);
try {
  const deployments = new Deployments(c.db),
    manifest = c.registry.deployment();
  const current = await deployments.current();
  const id = revisionId(manifest);
  if (operation !== "plan") await deployments.stage(manifest);
  if (operation === "activate") {
    if (!expected || !reason)
      throw new Error(
        "Usage: deployment activate <expected-revision|none> <reason>",
      );
    await deployments.activate(
      id,
      expected === "none" ? null : expected,
      "deployment-cli",
      reason,
    );
  }
  process.stdout.write(
    JSON.stringify(
      {
        operation,
        id,
        previous: current?.id ?? null,
        diff: deploymentDiff(current?.manifest ?? null, manifest),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await c.close();
}
