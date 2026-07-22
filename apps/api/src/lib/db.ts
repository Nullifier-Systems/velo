import "dotenv/config";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface DbClient {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

export interface DbPool {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<DbClient>;
}

/**
 * Two modes:
 *
 * - Production/dev: a real `pg` Pool against DATABASE_URL. This is what
 *   actually satisfies "replace the in-memory Map with a real, persistent
 *   database" — a redeploy does not touch this data.
 *
 * - Tests (VITEST is set automatically by the test runner): an in-process
 *   PGlite instance — an actual Postgres engine compiled to WASM, not a
 *   mock/emulator. This runs the real migration SQL (including the
 *   pgcrypto extension) with zero external services, so `npm run test`
 *   needs no Postgres server, no Docker, and no CI changes.
 */
async function createPool(): Promise<DbPool> {
  if (process.env.VITEST) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const db = new PGlite({ extensions: { pgcrypto } });

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../db/migrations"
    );
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      await db.exec(readFileSync(path.join(migrationsDir, f), "utf8"));
    }

    const runQuery = async <T>(text: string, params?: unknown[]): Promise<QueryResult<T>> => {
      const result = await db.query<T>(text, params as any[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    };

    return {
      query: runQuery,
      connect: async () => ({
        query: runQuery,
        release: () => {},
      }),
    };
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy apps/api/.env.example to .env and point it at a Postgres instance."
    );
  }
  const { Pool } = await import("pg");
  return new Pool({ connectionString }) as unknown as DbPool;
}

export const pool: DbPool = await createPool();