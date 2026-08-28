import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export const migrationsTableName = "schema_migrations";

export interface DatabaseRuntimeConfig {
  connectionString: string;
  applicationName: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
}

export type QueryParams = unknown[];

export interface Database {
  pool: Pool;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: QueryParams
  ): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(config: DatabaseRuntimeConfig): Database {
  const pool = new Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    ...(config.maxConnections ? { max: config.maxConnections } : {}),
    ...(config.statementTimeoutMs ? { statement_timeout: config.statementTimeoutMs } : {})
  });

  return {
    pool,
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: QueryParams = []
    ): Promise<QueryResult<T>> => pool.query<T>(sql, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

export async function runMigrations(
  pool: Pool,
  migrationsDir = defaultMigrationsDir()
): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTableName} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const existing = await pool.query(
      `SELECT 1 FROM ${migrationsTableName} WHERE version = $1`,
      [version]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO ${migrationsTableName} (version) VALUES ($1)`, [version]);
      await client.query("COMMIT");
      applied.push(version);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return applied;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newSecretToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}
