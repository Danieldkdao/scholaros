import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';

it('upgrades a previous local database without losing its connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scholaros-upgrade-'));
  const migrations = join(process.cwd(), 'src/db/migrations');
  const oldMigrations = join(directory, 'old');
  const sqlite = new Database(join(directory, 'old.sqlite'));
  try {
    cpSync(migrations, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 3,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: oldMigrations });
    sqlite
      .prepare(
        "INSERT INTO academic_connections (id, user_id, name, url, host, kind, status) VALUES ('a', 'student', 'School', 'https://school.edu/', 'school.edu', 'resource', 'confirmed')",
      )
      .run();
    migrate(db, { migrationsFolder: migrations });
    expect(
      sqlite
        .prepare('SELECT name, notes FROM academic_connections WHERE id = ?')
        .get('a'),
    ).toEqual({ name: 'School', notes: null });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
