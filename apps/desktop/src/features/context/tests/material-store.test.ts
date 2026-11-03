import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-materials-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
  };
});

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseTable,
} = await import('../../../db/schema');
const { buildMaterialContent } = await import('../lib/material-content');
const { saveCourseMaterial } = await import('../services/material-store');

const userId = 'material-student';
const connectionId = 'material-connection';
const courseId = 'material-course';
const courseUrl = 'https://canvas.school.edu/courses/1';
const materialUrl = `${courseUrl}/files/syllabus`;
const firstTime = '2026-11-01T12:00:00.000Z';
const secondTime = '2026-11-02T12:00:00.000Z';

const insertScope = () => {
  db.insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId,
      name: 'Canvas',
      url: 'https://canvas.school.edu/',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: 'verified',
      verifiedAt: firstTime,
      isCourseResource: true,
    })
    .run();
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId,
      connectionId,
      sourceKey: 'canvas course 1',
      sourceName: 'Canvas',
      sourceHost: 'canvas.school.edu',
      externalId: '1',
      name: 'Biology',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: courseUrl,
      firstSeenAt: firstTime,
      lastSeenAt: firstTime,
      contentChangedAt: null,
      overviewSyncedAt: null,
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    })
    .run();
};

const buildContent = (text: string) =>
  buildMaterialContent({
    sourceUrl: materialUrl,
    text,
    maxChars: 500,
    overlapChars: 40,
  });

const ftsCount = (query: string) =>
  db.$client
    .prepare(
      'SELECT COUNT(*) AS count FROM course_material_chunks_fts WHERE course_material_chunks_fts MATCH ?',
    )
    .get(query) as { count: number };

const write = (text: string, now = firstTime) =>
  saveCourseMaterial({
    userId,
    connectionId,
    courseId,
    source: {
      url: materialUrl,
      title: 'Biology syllabus',
      sourceType: 'syllabus',
      extractionStatus: 'complete',
      completeness: 100,
      summary: null,
      summaryEvidence: [],
      retrievedAt: now,
      verifiedAt: now,
    },
    content: buildContent(text),
  });

beforeEach(() => {
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  insertScope();
});

describe('course material storage', () => {
  it('stores source metadata and versioned passages under the verified course scope', () => {
    const saved = write('# Syllabus\nFinal exam: December 8, 2026.');

    expect(saved).toMatchObject({
      changed: true,
      material: {
        userId,
        connectionId,
        courseId,
        url: materialUrl,
        title: 'Biology syllabus',
        sourceType: 'syllabus',
        extractionStatus: 'complete',
      },
    });
    expect(db.select().from(CourseMaterialTable).all()).toHaveLength(1);
    expect(db.select().from(CourseMaterialChunkTable).all()).toMatchObject([
      {
        version: saved?.material.contentHash,
        locator: null,
        text: 'Final exam: December 8, 2026.',
      },
    ]);
    expect(ftsCount('"December 8"').count).toBe(1);
  });

  it('keeps the material ID and passage rows stable when the content is unchanged', () => {
    const first = write('# Syllabus\nFinal exam: December 8, 2026.')!;
    const previousChangedAt = first.material.contentChangedAt;
    const firstPassages = db.select().from(CourseMaterialChunkTable).all();
    const repeated = write(
      '# Syllabus\nFinal exam: December 8, 2026.',
      secondTime,
    )!;

    expect(repeated.changed).toBe(false);
    expect(repeated.material.id).toBe(first.material.id);
    expect(repeated.material.contentChangedAt).toBe(previousChangedAt);
    expect(repeated.material.retrievedAt).toBe(secondTime);
    expect(db.select().from(CourseMaterialChunkTable).all()).toEqual(
      firstPassages,
    );
  });

  it('replaces passages transactionally when the source version changes', () => {
    const first = write('# Syllabus\nFinal exam: December 8, 2026.')!;
    const changed = write(
      '# Syllabus\nFinal exam: December 9, 2026.',
      secondTime,
    )!;
    const passages = db.select().from(CourseMaterialChunkTable).all();

    expect(changed.changed).toBe(true);
    expect(changed.material.id).toBe(first.material.id);
    expect(changed.material.contentHash).not.toBe(first.material.contentHash);
    expect(changed.material.contentChangedAt).toBe(secondTime);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.version).toBe(changed.material.contentHash);
    expect(passages[0]?.text).toContain('December 9, 2026');
    expect(ftsCount('"December 8"').count).toBe(0);
    expect(ftsCount('"December 9"').count).toBe(1);
  });

  it('preserves readable cached passages when a later extraction is unreadable', () => {
    const previous = write('Mitochondria power the cell.')!;
    const saved = saveCourseMaterial({
      userId,
      connectionId,
      courseId,
      source: {
        url: materialUrl,
        title: 'Biology syllabus',
        sourceType: 'syllabus',
        extractionStatus: 'unreadable',
        completeness: 0,
        summary: null,
        summaryEvidence: [],
        retrievedAt: secondTime,
        verifiedAt: secondTime,
      },
      content: buildContent(''),
    });

    expect(saved).toBeNull();
    expect(db.select().from(CourseMaterialTable).all()).toMatchObject([
      {
        contentHash: previous.material.contentHash,
        verifiedAt: firstTime,
        extractionStatus: 'complete',
      },
    ]);
    expect(ftsCount('Mitochondria').count).toBe(1);
  });

  it('preserves the previous version if a passage write fails inside the transaction', () => {
    const first = write('# Syllabus\nFinal exam: December 8, 2026.')!;
    const content = buildContent('# Syllabus\nFinal exam: December 9, 2026.');
    content.passages.push({ ...content.passages[0]!, ordinal: 0 });
    const failed = saveCourseMaterial({
      userId,
      connectionId,
      courseId,
      source: {
        url: materialUrl,
        title: 'Biology syllabus',
        sourceType: 'syllabus',
        extractionStatus: 'complete',
        completeness: 100,
        summary: null,
        summaryEvidence: [],
        retrievedAt: secondTime,
        verifiedAt: secondTime,
      },
      content,
    });

    expect(failed).toBeNull();
    expect(db.select().from(CourseMaterialTable).all()[0]?.id).toBe(
      first.material.id,
    );
    expect(db.select().from(CourseMaterialChunkTable).all()).toMatchObject([
      {
        version: first.material.contentHash,
        text: 'Final exam: December 8, 2026.',
      },
    ]);
    expect(ftsCount('"December 8"').count).toBe(1);
    expect(ftsCount('"December 9"').count).toBe(0);
  });

  it('rejects another account and unsafe material URLs', () => {
    const source = {
      url: materialUrl,
      title: 'Biology syllabus',
      sourceType: 'syllabus' as const,
      extractionStatus: 'complete' as const,
      completeness: 100,
      summary: null,
      summaryEvidence: [],
      retrievedAt: firstTime,
      verifiedAt: firstTime,
    };
    const content = buildContent('# Syllabus\nFinal exam: December 8, 2026.');
    expect(
      saveCourseMaterial({
        userId: 'another-student',
        connectionId,
        courseId,
        source,
        content,
      }),
    ).toBeNull();
    expect(
      saveCourseMaterial({
        userId,
        connectionId,
        courseId,
        source: {
          ...source,
          url: 'https://canvas.school.edu.evil.example/courses/1/files',
        },
        content,
      }),
    ).toBeNull();
    expect(db.select().from(CourseMaterialTable).all()).toHaveLength(0);
  });
});
