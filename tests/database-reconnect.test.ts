import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("idle database disconnect does not crash the process and a later query reconnects", async () => {
  assert.ok(
    new URL(process.env.TEST_DATABASE_URL!).pathname.startsWith(
      "/cloud_agent_test_",
    ),
  );
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {Database} from './packages/persistence/database.ts';
    const db=new Database(process.env.TEST_DATABASE_URL), control=new Database(process.env.TEST_DATABASE_URL);
    try {
      const pid=(await db.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await control.pool.query('SELECT pg_terminate_backend($1)',[pid]);
      await new Promise(r=>setTimeout(r,100));
      if((await db.pool.query('SELECT 1 AS ok')).rows[0].ok!==1) throw new Error('reconnection failed');
      process.stdout.write('reconnected');
    }finally{await db.close();await control.close();}
  `,
    ],
    { timeout: 15000 },
  );
  assert.equal(result.stdout, "reconnected");
  assert.match(result.stderr, /database.idle_connection_lost/);
  assert.doesNotMatch(result.stderr, /postgres:\/\//);
});
