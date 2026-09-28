import { CancellationNotifications } from "./cancellation.js";
/** PostgreSQL 事务与迁移基础设施；网络副作用必须放在事务外。 */
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
export { fingerprint, tokenHash } from "../contracts/fingerprint.js";
import { fingerprint } from "../contracts/fingerprint.js";
export class Database {
  readonly pool: Pool;
  readonly cancellations: CancellationNotifications;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 20,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    this.cancellations = new CancellationNotifications(this.pool);
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cloud-agent-migrations'))",
      );
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const name of (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        const sql = await readFile(`migrations/${name}`, "utf8");
        const checksum = fingerprint(sql);
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE name=$1",
          [name],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum)
            throw new Error(`Migration changed: ${name}`);
          continue;
        }
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)",
          [name, checksum],
        );
      }
    });
  }
  async close(): Promise<void> {
    await this.cancellations.close();
    await this.pool.end();
  }
}
