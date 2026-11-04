import { createHash } from 'node:crypto';
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
import { expect, it, vi } from 'vitest';

const legacyMaterialText = 'Mitosis preserves the parent cell lineage.';
const legacyMaterialHash = createHash('sha256')
  .update(legacyMaterialText)
  .digest('hex');

it('preserves existing course, material, FTS, and watch checkpoints through product migrations', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'scholaros-product-persistence-'),
  );
  const migrations = join(process.cwd(), 'src/db/migrations');
  const previousMigrations = join(directory, 'before-0014');
  const sqlite = new Database(join(directory, 'fixture.sqlite'));
  sqlite.pragma('foreign_keys = ON');
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
      INSERT INTO academic_connections (
        id, user_id, name, url, host, kind, status, verified_at,
        is_course_resource
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'connection-1',
        'fixture-user',
        'School',
        'https://school.example/',
        'school.example',
        'resource',
        'verified',
        '2026-01-01T00:00:00.000Z',
        1,
      );
    sqlite
      .prepare(`
      INSERT INTO courses (
        id, user_id, connection_id, source_key, source_name, source_host,
        name, url, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'manual-course',
        'fixture-user',
        'connection-1',
        'manual:manual-course',
        'School',
        'school.example',
        'Saved course',
        'https://school.example/courses/biology',
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
        legacyMaterialHash,
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
        legacyMaterialHash,
        0,
        'Mitosis',
        'page:1',
        legacyMaterialText,
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
    ).toEqual({ current_usable_version: legacyMaterialHash });
    expect(
      sqlite
        .prepare(
          'SELECT content_hash FROM course_material_versions WHERE material_id = ?',
        )
        .get('material-1'),
    ).toEqual({ content_hash: legacyMaterialHash });
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

    vi.doMock('../../../db', () => ({ db }));
    try {
      const [materialStore, materialReads, materialContent] = await Promise.all(
        [
          import('../services/material-store'),
          import('../services/read-actions'),
          import('../lib/material-content'),
        ],
      );
      const searchInput = {
        userId: 'fixture-user',
        connectionId: 'connection-1',
        courseId: 'manual-course',
        query: 'lineage',
      };
      expect(
        materialReads.searchCourseMaterialPassages(searchInput)?.passages,
      ).toMatchObject([
        {
          id: 'material-chunk-1',
          version: legacyMaterialHash,
          text: legacyMaterialText,
        },
      ]);
      const updatedMaterial = materialStore.saveCourseMaterial({
        userId: 'fixture-user',
        connectionId: 'connection-1',
        courseId: 'manual-course',
        source: {
          url: 'https://school.example/material-1',
          title: 'Saved material',
          sourceType: 'reading',
          extractionStatus: 'complete',
          completeness: 100,
          summary: null,
          summaryEvidence: [],
          retrievedAt: '2026-01-03T00:00:00.000Z',
          verifiedAt: '2026-01-03T00:00:00.000Z',
        },
        content: materialContent.buildMaterialContent({
          sourceUrl: 'https://school.example/material-1',
          text: 'Chromosome cycles organize cell division.',
        }),
      });
      expect(updatedMaterial).toMatchObject({
        changed: true,
        material: { id: 'material-1' },
      });
      expect(
        materialReads.searchCourseMaterialPassages(searchInput)?.passages,
      ).toEqual([]);
      const updatedPassages = materialReads.searchCourseMaterialPassages({
        ...searchInput,
        query: 'chromosome',
      })?.passages;
      expect(updatedPassages).toHaveLength(1);
      expect(
        materialReads.readCourseMaterialPassages({
          userId: 'fixture-user',
          connectionId: 'connection-1',
          courseId: 'manual-course',
          selections: updatedPassages!.map(({ id, version }) => ({
            id,
            version,
          })),
        }),
      ).toHaveLength(1);
    } finally {
      vi.doUnmock('../../../db');
    }

    sqlite
      .prepare(`
      INSERT INTO context_items (
        id, user_id, title, kind, provenance, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'context-item-1',
        'fixture-user',
        'Saved note',
        'note',
        'user-authored',
        'complete',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    const insertContextVersion = sqlite.prepare(`
      INSERT INTO context_versions (
        id, user_id, item_id, attempt_id, original_hash, content_hash,
        mime_type, byte_length, extracted_text, extraction_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertContextVersion.run(
      'context-version-1',
      'fixture-user',
      'context-item-1',
      'extract-1',
      'same-original-bytes',
      'first-extraction',
      'text/plain',
      32,
      'The first immutable extraction.',
      'complete',
      '2026-01-01T00:00:00.000Z',
    );
    insertContextVersion.run(
      'context-version-2',
      'fixture-user',
      'context-item-1',
      'extract-2',
      'same-original-bytes',
      'second-extraction',
      'text/plain',
      32,
      'A later extraction retry.',
      'complete',
      '2026-01-02T00:00:00.000Z',
    );
    expect(
      sqlite
        .prepare(`
        SELECT attempt_id, content_hash, extracted_text
        FROM context_versions WHERE item_id = ? ORDER BY attempt_id
      `)
        .all('context-item-1'),
    ).toEqual([
      {
        attempt_id: 'extract-1',
        content_hash: 'first-extraction',
        extracted_text: 'The first immutable extraction.',
      },
      {
        attempt_id: 'extract-2',
        content_hash: 'second-extraction',
        extracted_text: 'A later extraction retry.',
      },
    ]);
    expect(() =>
      insertContextVersion.run(
        'context-version-duplicate',
        'fixture-user',
        'context-item-1',
        'extract-1',
        'same-original-bytes',
        'duplicate-extraction',
        'text/plain',
        32,
        'Duplicate attempt.',
        'complete',
        '2026-01-03T00:00:00.000Z',
      ),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare('UPDATE context_versions SET extracted_text = ? WHERE id = ?')
        .run('Mutated citation.', 'context-version-1'),
    ).toThrow(/immutable/i);
    sqlite
      .prepare(`
      INSERT INTO artifact_versions (
        id, artifact_id, user_id, content_digest, html, css, javascript,
        runtime_version, source_references, policy_decision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        'artifact-version-1',
        'artifact-1',
        'fixture-user',
        'digest-1',
        '<p>Accepted version</p>',
        '',
        '',
        1,
        '[]',
        '{}',
        '2026-01-01T00:00:00.000Z',
      );
    expect(() =>
      sqlite
        .prepare('UPDATE artifact_versions SET html = ? WHERE id = ?')
        .run('<p>Mutated version</p>', 'artifact-version-1'),
    ).toThrow(/immutable/i);

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

    const insertStudyTurn = (id: string) =>
      sqlite
        .prepare(`
        INSERT INTO study_turns (
          id, user_id, session_id, request_id, payload_hash, generation_epoch,
          status, policy_revision, context_revision, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'session-1',
          'request-1',
          'payload-hash',
          0,
          'preparing',
          0,
          0,
          '2026-01-01T00:00:00.000Z',
        );
    insertStudyTurn('turn-1');
    expect(() => insertStudyTurn('turn-duplicate')).toThrow();

    const insertStudyMessage = (id: string) =>
      sqlite
        .prepare(`
        INSERT INTO study_messages (
          id, user_id, session_id, sequence, role, status, parts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'session-1',
          1,
          'student',
          'accepted',
          '[]',
          '2026-01-01T00:00:00.000Z',
        );
    insertStudyMessage('message-1');
    expect(() => insertStudyMessage('message-duplicate-sequence')).toThrow();

    const insertArtifactState = (id: string) =>
      sqlite
        .prepare(`
        INSERT INTO artifact_states (
          id, user_id, artifact_id, version_id, attempt_id, state, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'artifact-1',
          'artifact-version-1',
          'attempt-1',
          '{}',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
    insertArtifactState('artifact-state-1');
    expect(() => insertArtifactState('artifact-state-duplicate')).toThrow();

    const insertPracticeAnswer = (id: string) =>
      sqlite
        .prepare(`
        INSERT INTO practice_answers (
          id, user_id, attempt_id, question_id, revision, answer, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'practice-attempt-1',
          'question-1',
          1,
          '{}',
          '2026-01-01T00:00:00.000Z',
        );
    insertPracticeAnswer('practice-answer-1');
    expect(() => insertPracticeAnswer('practice-answer-duplicate')).toThrow();

    const insertNotification = (id: string) =>
      sqlite
        .prepare(`
        INSERT INTO notification_events (
          id, user_id, category, target_kind, outcome_id,
          preference_revision, status, expires_at, safe_route, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'sync-completed',
          'course',
          'sync-outcome-1',
          0,
          'queued',
          '2026-01-02T00:00:00.000Z',
          '{"kind":"today"}',
          '2026-01-01T00:00:00.000Z',
        );
    insertNotification('notification-1');
    expect(() => insertNotification('notification-duplicate')).toThrow();

    const insertAssistanceEntry = (id: string, turnId: string) =>
      sqlite
        .prepare(`
        INSERT INTO assistance_ledger (
          id, user_id, course_id, protection_id, question_fingerprint,
          turn_id, allowed_support_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          id,
          'fixture-user',
          'course-1',
          'protection-1',
          'question-fingerprint-1',
          turnId,
          '{}',
          '2026-01-01T00:00:00.000Z',
        );
    insertAssistanceEntry('assistance-1', 'turn-1');
    expect(() =>
      insertAssistanceEntry('assistance-duplicate', 'turn-1'),
    ).toThrow();
    expect(() =>
      insertAssistanceEntry('assistance-next-turn', 'turn-2'),
    ).not.toThrow();
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
  sqlite.pragma('foreign_keys = ON');
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
