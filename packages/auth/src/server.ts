import 'server-only';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '@scholaros/cloud-db';
import { betterAuth } from 'better-auth';
import { authOptions } from './options';

export const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter(db, { provider: 'pg' }),
});
