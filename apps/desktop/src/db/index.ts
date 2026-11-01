import { app } from 'electron';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index';

const directory = path.join(app.getPath('userData'), 'data');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);

const sqlite = new Database(path.join(directory, 'scholaros.sqlite'));

export const db = drizzle({ client: sqlite, schema });

const migrationsFolder = app.isPackaged
  ? path.join(process.resourcesPath, 'migrations')
  : path.join(app.getAppPath(), 'src/db/migrations');

try {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(db, { migrationsFolder });
} catch (error) {
  sqlite.close();
  throw error;
}

app.once('will-quit', () => sqlite.close());
