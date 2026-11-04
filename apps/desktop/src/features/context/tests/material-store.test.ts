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
  CourseMaterialVersionTable,
  CourseTable,
  StudySourceReferenceTable,
} = await import('../../../db/schema');
const { buildMaterialContent } = await import('../lib/material-content');
const {
  deleteCourseMaterial,
  reconcileMaterialCollection,
  saveCourseMaterial,
} = await import('../services/material-store');

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

const write = (
  text: string,
  now = firstTime,
  extractionStatus: 'complete' | 'partial' = 'complete',
  sourceUrl = materialUrl,
) =>
  saveCourseMaterial({
    userId,
    connectionId,
    courseId,
    source: {
      url: sourceUrl,
      title: 'Biology syllabus',
      sourceType: 'syllabus',
      extractionStatus,
      completeness: extractionStatus === 'complete' ? 100 : 50,
      summary: null,
      summaryEvidence: [],
      retrievedAt: now,
      verifiedAt: now,
    },
    content: buildMaterialContent({ sourceUrl, text }),
  });

beforeEach(() => {
  db.delete(StudySourceReferenceTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialVersionTable).run();
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

  it('archives changed content while retaining earlier passages and FTS entries', () => {
    const first = write('# Syllabus\nFinal exam: December 8, 2026.')!;
    const changed = write(
      '# Syllabus\nFinal exam: December 9, 2026.',
      secondTime,
    )!;
    const passages = db.select().from(CourseMaterialChunkTable).all();
    const versions = db.select().from(CourseMaterialVersionTable).all();

    expect(changed.changed).toBe(true);
    expect(changed.material.id).toBe(first.material.id);
    expect(changed.material.contentHash).not.toBe(first.material.contentHash);
    expect(changed.material.currentUsableVersion).toBe(
      changed.material.contentHash,
    );
    expect(changed.material.contentChangedAt).toBe(secondTime);
    expect(passages).toHaveLength(2);
    expect(passages.map(({ version }) => version)).toContain(
      first.material.contentHash,
    );
    expect(passages.map(({ version }) => version)).toContain(
      changed.material.contentHash,
    );
    expect(versions).toHaveLength(2);
    expect(ftsCount('"December 8"').count).toBe(1);
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

    expect(saved).toMatchObject({
      outcome: 'preserved-current',
      changed: false,
      material: {
        contentHash: previous.material.contentHash,
        currentUsableVersion: previous.material.contentHash,
        verifiedAt: firstTime,
        extractionStatus: 'unreadable',
        lastAttemptAt: secondTime,
      },
    });
    expect(db.select().from(CourseMaterialTable).all()).toHaveLength(1);
    expect(db.select().from(CourseMaterialChunkTable).all()).toMatchObject([
      {
        version: previous.material.contentHash,
        text: 'Mitochondria power the cell.',
      },
    ]);
    expect(db.select().from(CourseMaterialVersionTable).all()).toHaveLength(1);
    expect(ftsCount('Mitochondria').count).toBe(1);
  });

  it('retains a usable partial version after an unreadable retry', () => {
    const previous = write(
      'Mitochondria power the cell.',
      firstTime,
      'partial',
    )!;
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

    expect(saved).toMatchObject({
      outcome: 'preserved-current',
      material: {
        contentHash: previous.material.contentHash,
        currentUsableVersion: previous.material.contentHash,
        extractionStatus: 'unreadable',
      },
    });
    expect(ftsCount('Mitochondria').count).toBe(1);
  });

  it('does not reactivate a suppressed material during refresh', () => {
    const previous = write('Mitochondria power the cell.')!;
    db.$client
      .prepare(
        'UPDATE course_materials SET suppression_id = ?, suppressed_at = ? WHERE id = ?',
      )
      .run('student-hidden-material', secondTime, previous.material.id);

    const refreshed = write('Cell membranes control transport.', secondTime);

    expect(refreshed).toBeNull();
    expect(db.select().from(CourseMaterialTable).all()).toMatchObject([
      {
        id: previous.material.id,
        suppressionId: 'student-hidden-material',
        suppressedAt: secondTime,
        currentUsableVersion: previous.material.contentHash,
      },
    ]);
    expect(ftsCount('Mitochondria').count).toBe(1);
    expect(ftsCount('membranes').count).toBe(0);
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

  it('retires unseen materials only after verified complete coverage', () => {
    const retained = write('Mitochondria power the cell.')!;
    const retired = write(
      'Membrane transport regulates the cell.',
      firstTime,
      'complete',
      `${courseUrl}/files/lecture`,
    )!;
    const hostCoverage = {
      ownerId: userId,
      connectionId,
      courseId,
      collectionKind: 'materials' as const,
      collectionUrls: [courseUrl],
      observedAt: secondTime,
      usableItemCount: 1,
      pagination: {
        state: 'not-applicable' as const,
        visitedPageUrls: [courseUrl],
      },
      explicitEmptyEvidence: null,
      gaps: {
        pendingPagination: false,
        unreadable: false,
        blockedRequiredData: false,
        truncated: false,
        invalidRecords: false,
        ambiguousIdentity: false,
        scopeUnverified: false,
      },
    };

    const partial = reconcileMaterialCollection(
      { userId, connectionId, courseId },
      {
        coverage: {
          ...hostCoverage,
          gaps: { ...hostCoverage.gaps, unreadable: true },
        },
        seenIds: [retained.material.id],
      },
    );
    expect(partial).toBeNull();
    expect(
      db
        .select()
        .from(CourseMaterialTable)
        .all()
        .every(({ active }) => active),
    ).toBe(true);

    db.insert(AcademicConnectionTable)
      .values({
        id: 'material-secondary-connection',
        userId,
        name: 'Files',
        url: 'https://files.school.edu/',
        host: 'files.school.edu',
        kind: 'resource',
        status: 'verified',
        verifiedAt: firstTime,
        isCourseResource: true,
      })
      .run();
    db.$client
      .prepare(
        'UPDATE academic_connections SET is_course_resource = 0 WHERE id = ?',
      )
      .run('material-secondary-connection');
    const revokedHostCoverage = {
      ...hostCoverage,
      pagination: {
        state: 'not-applicable' as const,
        visitedPageUrls: [courseUrl, 'https://files.school.edu/lecture'],
      },
    };
    expect(
      reconcileMaterialCollection(
        { userId, connectionId, courseId },
        {
          coverage: revokedHostCoverage,
          seenIds: [retained.material.id],
        },
      ),
    ).toBeNull();
    expect(
      db
        .select()
        .from(CourseMaterialTable)
        .all()
        .every(({ active }) => active),
    ).toBe(true);

    const complete = reconcileMaterialCollection(
      { userId, connectionId, courseId },
      {
        coverage: hostCoverage,
        seenIds: [retained.material.id],
      },
    );

    expect(complete).toEqual({ retiredMaterialIds: [retired.material.id] });
    expect(db.select().from(CourseMaterialTable).all()).toMatchObject([
      { id: retained.material.id, active: true },
      { id: retired.material.id, active: false },
    ]);
    expect(db.select().from(CourseMaterialVersionTable).all()).toHaveLength(2);
    expect(db.select().from(CourseMaterialChunkTable).all()).toHaveLength(2);
  });

  it('fully deletes a material with every version, passage, FTS row and saved reference', () => {
    const first = write('Mitochondria power the cell.')!;
    write('Mitochondria convert nutrients into energy.', secondTime);
    db.insert(StudySourceReferenceTable)
      .values({
        id: 'saved-material-reference',
        userId,
        sessionId: 'study-session',
        messageId: 'study-message',
        sourceKind: 'course-material',
        sourceId: first.material.id,
        versionId: first.material.contentHash,
        locator: { kind: 'page', page: 1 },
        state: 'historical',
      })
      .run();

    const deleted = deleteCourseMaterial({
      userId,
      connectionId,
      courseId,
      materialId: first.material.id,
    });

    expect(deleted).toEqual({ deleted: true });
    expect(db.select().from(CourseMaterialTable).all()).toEqual([]);
    expect(db.select().from(CourseMaterialVersionTable).all()).toEqual([]);
    expect(db.select().from(CourseMaterialChunkTable).all()).toEqual([]);
    expect(db.select().from(StudySourceReferenceTable).all()).toEqual([]);
    expect(ftsCount('Mitochondria').count).toBe(0);
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
