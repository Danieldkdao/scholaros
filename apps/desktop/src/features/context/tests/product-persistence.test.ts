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

it('preserves existing course, material, FTS, and watch checkpoints through product migrations', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'scholaros-product-persistence-'),
  );
  const migrations = join(process.cwd(), 'src/db/migrations');
  const previousMigrations = join(directory, 'before-0014');
  const sqlite = new Database(join(directory, 'fixture.sqlite'));
  const db = drizzle(sqlite);

  try {
    cpSync(migrations, previousMigrations, { recursive: true });
    const journalPath = join(previousMigrations, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 14,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    migrate(db, { migrationsFolder: previousMigrations });

    sqlite
      .prepare(`
      INSERT INTO courses (
        id, user_id, source_key, source_name, source_host, name, url,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'manual-course',
        'fixture-user',
        'manual:manual-course',
        'Manual',
        '',
        'Saved course',
        '',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    sqlite
      .prepare(`
      INSERT INTO course_assignments (
        id, user_id, course_id, source_key, title, body, url, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'manual-assignment',
        'fixture-user',
        'manual-course',
        'manual:manual-assignment',
        'Student note',
        'Preserve this locally authored text.',
        '',
        '2026-01-01T00:00:00.000Z',
      );
    sqlite
      .prepare(`
      INSERT INTO course_materials (
        id, user_id, connection_id, course_id, source_identity, url, title,
        source_type, content_hash, extraction_status, completeness
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'material-1',
        'fixture-user',
        'connection-1',
        'manual-course',
        'https://school.example/material-1',
        'https://school.example/material-1',
        'Saved material',
        'pdf',
        'content-v1',
        'complete',
        100,
      );
    sqlite
      .prepare(`
      INSERT INTO course_material_chunks (
        id, material_id, version, ordinal, heading, locator, text, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'material-chunk-1',
        'material-1',
        'content-v1',
        0,
        'Mitosis',
        'page:1',
        'Mitosis preserves the parent cell lineage.',
        'https://school.example/material-1',
      );
    sqlite
      .prepare(`
      INSERT INTO watch_targets (
        id, user_id, connection_id, requested_url, url_identity,
        detected_fingerprint, processed_fingerprint, pending_change,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'watch-1',
        'fixture-user',
        'connection-1',
        'https://school.example/course',
        'https://school.example/course',
        'revision-new',
        'revision-old',
        1,
        'active',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      );

    migrate(db, { migrationsFolder: migrations });

    expect(
      sqlite
        .prepare('SELECT id, source_key FROM courses WHERE id = ?')
        .get('manual-course'),
    ).toEqual({ id: 'manual-course', source_key: 'manual:manual-course' });
    expect(
      sqlite
        .prepare('SELECT id, body FROM course_assignments WHERE id = ?')
        .get('manual-assignment'),
    ).toEqual({
      id: 'manual-assignment',
      body: 'Preserve this locally authored text.',
    });
    expect(
      sqlite
        .prepare(
          'SELECT current_usable_version FROM course_materials WHERE id = ?',
        )
        .get('material-1'),
    ).toEqual({ current_usable_version: 'content-v1' });
    expect(
      sqlite
        .prepare(
          'SELECT content_hash FROM course_material_versions WHERE material_id = ?',
        )
        .get('material-1'),
    ).toEqual({ content_hash: 'content-v1' });
    expect(
      sqlite
        .prepare(`
        SELECT id FROM course_material_chunks_fts
        WHERE course_material_chunks_fts MATCH 'lineage'
      `)
        .all(),
    ).toEqual([{ id: 'material-chunk-1' }]);
    expect(
      sqlite
        .prepare(`
        SELECT pending_since, pending_since_estimated, detected_fingerprint, processed_fingerprint
        FROM watch_targets WHERE id = ?
      `)
        .get('watch-1'),
    ).toEqual({
      pending_since: '2026-01-02T00:00:00.000Z',
      pending_since_estimated: 1,
      detected_fingerprint: 'revision-new',
      processed_fingerprint: 'revision-old',
    });

    sqlite
      .prepare(`
      INSERT INTO context_chunks (
        id, user_id, item_id, version_id, ordinal, text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        'context-chunk-1',
        'fixture-user',
        'context-item-1',
        'context-version-1',
        0,
        'A grounded context citation.',
      );
    expect(
      sqlite
        .prepare(`
        SELECT id FROM context_chunks_fts
        WHERE context_chunks_fts MATCH 'grounded'
      `)
        .all(),
    ).toEqual([{ id: 'context-chunk-1' }]);

    sqlite
      .prepare('UPDATE context_chunks SET text = ? WHERE id = ?')
      .run('A revised source citation.', 'context-chunk-1');
    expect(
      sqlite
        .prepare(`
        SELECT id FROM context_chunks_fts
        WHERE context_chunks_fts MATCH 'grounded'
      `)
        .all(),
    ).toEqual([]);
    expect(
      sqlite
        .prepare(`
        SELECT id FROM context_chunks_fts
        WHERE context_chunks_fts MATCH 'revised'
      `)
        .all(),
    ).toEqual([{ id: 'context-chunk-1' }]);
    sqlite
      .prepare('DELETE FROM context_chunks WHERE id = ?')
      .run('context-chunk-1');
    expect(
      sqlite
        .prepare(`
        SELECT id FROM context_chunks_fts
        WHERE context_chunks_fts MATCH 'revised'
      `)
        .all(),
    ).toEqual([]);

    const insertContextLink = sqlite.prepare(`
      INSERT INTO context_links (id, user_id, item_id, retained_in_library, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertContextLink.run(
      'library-link-1',
      'fixture-user',
      'context-item-1',
      1,
      '2026-01-01T00:00:00.000Z',
    );
    expect(() =>
      insertContextLink.run(
        'library-link-2',
        'fixture-user',
        'context-item-1',
        1,
        '2026-01-01T00:00:00.000Z',
      ),
    ).toThrow();
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('upgrades an 0008 database while preserving legacy context and manual records', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'scholaros-legacy-persistence-'),
  );
  const migrations = join(process.cwd(), 'src/db/migrations');
  const previousMigrations = join(directory, 'before-0009');
  const sqlite = new Database(join(directory, 'fixture.sqlite'));
  const db = drizzle(sqlite);

  try {
    cpSync(migrations, previousMigrations, { recursive: true });
    const journalPath = join(previousMigrations, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 9,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    migrate(db, { migrationsFolder: previousMigrations });

    sqlite
      .prepare(`
      INSERT INTO academic_connections (
        id, user_id, name, url, host, kind, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'legacy-connection',
        'fixture-user',
        'School',
        'https://school.example/',
        'school.example',
        'resource',
        'confirmed',
      );
    sqlite
      .prepare(`
      INSERT INTO academic_context (user_id, primary_lms)
      VALUES (?, ?)
    `)
      .run('fixture-user', 'legacy-connection');
    sqlite
      .prepare(`
      INSERT INTO academic_context_entries (
        id, user_id, connection_id, label, url, role, evidence_url, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'legacy-context-entry',
        'fixture-user',
        'legacy-connection',
        'Biology course',
        'https://school.example/courses/biology',
        'course',
        'https://school.example/',
        '2026-01-01T00:00:00.000Z',
      );
    sqlite
      .prepare('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)')
      .run('fixture-user', '2026-01-01T00:00:00.000Z');
    sqlite
      .prepare(`
      INSERT INTO courses (
        id, user_id, source_key, source_name, source_host, name, url,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'manual-course',
        'fixture-user',
        'manual:manual-course',
        'Manual',
        '',
        'Saved course',
        '',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    sqlite
      .prepare(`
      INSERT INTO course_assignments (
        id, user_id, course_id, source_key, title, body, url, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'manual-assignment',
        'fixture-user',
        'manual-course',
        'manual:manual-assignment',
        'Saved note',
        'Keep this user-authored note.',
        '',
        '2026-01-01T00:00:00.000Z',
      );

    migrate(db, { migrationsFolder: migrations });

    expect(
      sqlite
        .prepare('SELECT id, label FROM academic_context_entries WHERE id = ?')
        .get('legacy-context-entry'),
    ).toEqual({ id: 'legacy-context-entry', label: 'Biology course' });
    expect(
      sqlite
        .prepare('SELECT id, source_key FROM courses WHERE id = ?')
        .get('manual-course'),
    ).toEqual({ id: 'manual-course', source_key: 'manual:manual-course' });
    expect(
      sqlite
        .prepare('SELECT id, body FROM course_assignments WHERE id = ?')
        .get('manual-assignment'),
    ).toEqual({
      id: 'manual-assignment',
      body: 'Keep this user-authored note.',
    });
    const productPreferences = JSON.parse(
      (
        sqlite
          .prepare('SELECT product_preferences FROM settings WHERE user_id = ?')
          .get('fixture-user') as { product_preferences: string }
      ).product_preferences,
    );
    expect(productPreferences.grades.enabled).toBe(false);
    expect(productPreferences.notifications.enabled).toBe(false);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
