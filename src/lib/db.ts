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

// Global singleton so Next.js HMR does not re-open embedded Postgres instances
const globalForDb = globalThis as unknown as {
  claimPilotDbPromise?: Promise<DbClient>;
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
    const isServerless =
      Boolean(process.env.NETLIFY) ||
      Boolean(process.env.LAMBDA_TASK_ROOT) ||
      Boolean(process.env.AWS_EXECUTION_ENV);

    let pglite: PGlite;
    if (isServerless) {
      // On Netlify serverless functions, use in-memory PGlite so concurrent invocations never collide on filesystem locks
      pglite = new PGlite();
    } else {
      const dataDir = path.join(process.cwd(), '.data', 'pgdata');
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      pglite = new PGlite(dataDir);
    }
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
  }

  // Apply migrations in order idempotently
  const migrationFiles = ['001_initial_schema.sql', '002_phase2_schema.sql'];
  for (const file of migrationFiles) {
    const migrationPath = path.join(process.cwd(), 'migrations', file);
    if (fs.existsSync(migrationPath)) {
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
      await client.exec(migrationSql);
    } else if (file === '001_initial_schema.sql' && MIGRATION_001_SQL) {
      await client.exec(MIGRATION_001_SQL);
    } else if (file === '002_phase2_schema.sql' && MIGRATION_002_SQL) {
      await client.exec(MIGRATION_002_SQL);
    }
  }

  return client;
}
