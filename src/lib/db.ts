import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATION_001_SQL, MIGRATION_002_SQL } from './migrations-sql';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

// Global singletons so Next.js HMR and concurrent initial requests share one DB & one seed run
const globalForDb = globalThis as unknown as {
  claimPilotDbPromise?: Promise<DbClient>;
  claimPilotSeedPromise?: Promise<void>;
};

export async function getDb(): Promise<DbClient> {
  if (!globalForDb.claimPilotDbPromise) {
    globalForDb.claimPilotDbPromise = initDatabase();
  }
  return globalForDb.claimPilotDbPromise;
}

async function initDatabase(): Promise<DbClient> {
  const connectionString = process.env.DATABASE_URL;
  let client: DbClient;

  if (connectionString) {
    const pool = new Pool({ connectionString });
    client = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const res = await pool.query(sql, params);
        return { rows: res.rows as T[] };
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
    };
  } else if (process.env.VITEST) {
    // Isolated in-memory PGlite per Vitest worker so parallel test files never lock .data/pgdata
    const pglite = new PGlite();
    await pglite.waitReady;

    client = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const res = await pglite.query<T>(sql, params);
        return { rows: res.rows };
      },
      async exec(sql: string) {
        await pglite.exec(sql);
      },
    };
  } else {
    // Use /tmp/.data/pgdata on serverless (Netlify / Lambda) so all route invocations inside the container
    // share the same persistent database state; fall back to in-memory PGlite only if disk init fails.
    const isServerless =
      Boolean(process.env.NETLIFY) ||
      Boolean(process.env.LAMBDA_TASK_ROOT) ||
      Boolean(process.env.AWS_EXECUTION_ENV) ||
      Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
      process.cwd().startsWith('/var/task');

    let pglite: PGlite;
    try {
      const dirParts = isServerless
        ? ['/tmp', 'claimpilot_pgdata']
        : ['.data', 'pgdata'];
      const dataDir = path.resolve(...dirParts);
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      pglite = new PGlite(dataDir);
      await pglite.waitReady;
    } catch {
      pglite = new PGlite();
      await pglite.waitReady;
    }

    client = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const res = await pglite.query<T>(sql, params);
        return { rows: res.rows };
      },
      async exec(sql: string) {
        await pglite.exec(sql);
      },
    };
  }

  // Apply inlined SQL migrations idempotently without runtime fs reads
  await client.exec(MIGRATION_001_SQL);
  await client.exec(MIGRATION_002_SQL);

  return client;
}
