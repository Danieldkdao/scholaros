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

it('upgrades a previous local database without losing its saved data', () => {
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
    sqlite
      .prepare(
        "INSERT INTO academic_context (user_id, primary_lms) VALUES ('student', 'a')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO academic_context_entries (id, user_id, connection_id, label, url, role, evidence_url, observed_at) VALUES ('e', 'student', 'a', 'Biology 101', 'https://school.edu/courses/1', 'course', 'https://school.edu/', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    migrate(db, { migrationsFolder: migrations });
    expect(
      sqlite
        .prepare(
          'SELECT name, notes, is_course_resource FROM academic_connections WHERE id = ?',
        )
        .get('a'),
    ).toEqual({ name: 'School', notes: null, is_course_resource: 0 });
    // Discovered links stay legacy context; the catalog fills on the next scan.
    expect(
      sqlite.prepare('SELECT label, role FROM academic_context_entries').all(),
    ).toEqual([{ label: 'Biology 101', role: 'course' }]);
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'courses',
        'course_announcements',
        'course_assignments',
        'course_sources',
      ]),
    );
    expect(sqlite.prepare('SELECT id FROM courses').all()).toEqual([]);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
