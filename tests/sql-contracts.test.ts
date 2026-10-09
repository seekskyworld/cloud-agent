/** 静态参数审计与真实 PostgreSQL 解析互补；PREPARE 不执行业务写入。 */
import test from "node:test";
import assert from "node:assert/strict";
import { files, queries } from "./fixtures/sql.js";
import { setup } from "./helpers.js";
test("static SQL placeholders match supplied arguments throughout production sources", async () => {
  let checked = 0;
  for (const root of ["packages", "adapters", "apps", "modules"])
    for (const path of await files(root))
      for (const query of await queries(path)) {
        if (query.parameters === undefined) continue;
        const slots = [...query.sql.matchAll(/\$(\d+)/g)].map((m) =>
          Number(m[1]),
        );
        assert.equal(Math.max(0, ...slots), query.parameters, query.location);
        checked++;
      }
  assert.ok(
    checked > 300,
    "production SQL audit must not silently skip its scope",
  );
});
test("production SQL parses against current migrations including columns and parameter types", async () => {
  const base = await setup();
  const client = await base.db.pool.connect();
  try {
    let checked = 0;
    for (const path of await files("packages")) {
      for (const query of await queries(path)) {
        if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(query.sql))
          continue;
        try {
          await client.query(`PREPARE framework_sql_audit AS ${query.sql}`);
        } catch (error) {
          throw new Error(`Invalid SQL at ${query.location}`, { cause: error });
        }
        await client.query("DEALLOCATE framework_sql_audit");
        checked++;
      }
    }
    assert.ok(checked > 300);
  } finally {
    await client.query("RESET search_path");
    client.release();
    await base.close();
  }
});
