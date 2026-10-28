import 'server-only';
import { serverEnv } from '@scholaros/env/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

const globalForDb = globalThis as typeof globalThis & {
  scholarosPool?: Pool;
};

const pool =
  globalForDb.scholarosPool ??
  new Pool({
    connectionString: serverEnv.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });

// Keep hot reload from creating additional development pools.
if (serverEnv.NODE_ENV !== 'production') {
  globalForDb.scholarosPool = pool;
}

export const db = drizzle({ client: pool, schema });
