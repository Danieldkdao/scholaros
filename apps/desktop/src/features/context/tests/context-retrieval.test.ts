import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-context-read-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
    },
  };
});

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseAssignmentTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseMaterialVersionTable,
  CourseTable,
  NavigationLocationTable,
  StudySourceReferenceTable,
} = await import('../../../db/schema');
const { buildMaterialContent } = await import('../lib/material-content');
const { createAcademicContextPackage } = await import('../lib/context-package');
const {
  getExistingResourceIdentities,
  getNavigationContextForTask,
  readCourseMaterialPassages,
  readHistoricalMaterialCitation,
  searchCourseMaterialPassages,
} = await import('../services/read-actions');
const { saveCourseMaterial } = await import('../services/material-store');
const { saveNavigationLocation } = await import('../services/navigation-store');

const userId = 'context-student';
const otherUserId = 'other-context-student';
const connectionId = 'context-connection';
const courseId = 'context-course';
const courseUrl = 'https://canvas.school.edu/courses/1';
const materialUrl = `${courseUrl}/files/biology-reading`;
const timestamp = '2026-11-01T12:00:00.000Z';

const insertScope = (accountId: string, suffix: string) => {
  const selectedConnectionId = `${connectionId}-${suffix}`;
  const selectedCourseId = `${courseId}-${suffix}`;
  const selectedCourseUrl = `https://canvas.school.edu/courses/${suffix}`;
  db.insert(AcademicConnectionTable)
    .values({
      id: selectedConnectionId,
      userId: accountId,
      name: 'Canvas',
      url: 'https://canvas.school.edu/',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: 'verified',
      verifiedAt: timestamp,
      isCourseResource: true,
    })
    .run();
  db.insert(CourseTable)
    .values({
      id: selectedCourseId,
      userId: accountId,
      connectionId: selectedConnectionId,
      sourceKey: `canvas course ${suffix}`,
      sourceName: 'Canvas',
      sourceHost: 'canvas.school.edu',
      externalId: suffix,
      name: suffix === '1' ? 'Biology' : 'Chemistry',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: selectedCourseUrl,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      contentChangedAt: null,
      overviewSyncedAt: null,
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    })
    .run();
  return {
    connectionId: selectedConnectionId,
    courseId: selectedCourseId,
    courseUrl: selectedCourseUrl,
  };
};

const writeMaterial = (
  scope = {
    userId,
    connectionId: `${connectionId}-1`,
    courseId: `${courseId}-1`,
    courseUrl,
  },
  text = '# Mitochondria\nBiology OR NEAR plan work powers the cell.',
  sourceUrl = materialUrl,
) =>
  saveCourseMaterial({
    userId: scope.userId,
    connectionId: scope.connectionId,
    courseId: scope.courseId,
    source: {
      url: sourceUrl,
      title: 'Biology reading',
      sourceType: 'reading',
      extractionStatus: 'complete',
      completeness: 100,
      summary: null,
      summaryEvidence: [],
      retrievedAt: timestamp,
      verifiedAt: timestamp,
    },
    content: buildMaterialContent({ sourceUrl, text }),
  });

beforeEach(() => {
  db.delete(StudySourceReferenceTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialVersionTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(NavigationLocationTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  insertScope(userId, '1');
  insertScope(otherUserId, '2');
});

describe('local academic context retrieval', () => {
  it('retrieves course materials hosted by another currently authorized resource', () => {
    db.insert(AcademicConnectionTable)
      .values({
        id: 'documents',
        userId,
        name: 'Documents',
        url: 'https://docs.school.edu/',
        host: 'docs.school.edu',
        kind: 'resource',
        status: 'verified',
        verifiedAt: timestamp,
        isCourseResource: true,
      })
      .run();
    const sourceUrl = 'https://docs.school.edu/biology/reading';
    expect(
      writeMaterial(undefined, 'Mitochondria power the cell.', sourceUrl),
    ).not.toBeNull();
    const query = {
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'Mitochondria',
    };
    const results = searchCourseMaterialPassages(query)!;

    expect(results.passages).toHaveLength(1);
    const selections = results.passages.map(({ id, version }) => ({
      id,
      version,
    }));
    const readInput = {
      userId,
      connectionId: query.connectionId,
      courseId: query.courseId,
      selections,
    };
    expect(readCourseMaterialPassages(readInput)).toHaveLength(1);
    db.$client
      .prepare(
        'UPDATE academic_connections SET is_course_resource = 0 WHERE id = ?',
      )
      .run('documents');
    expect(searchCourseMaterialPassages(query)?.passages).toHaveLength(0);
    expect(readCourseMaterialPassages(readInput)).toHaveLength(0);
  });

  it('searches bounded FTS terms and returns citation metadata inside the requested scope', () => {
    const saved = writeMaterial()!;
    writeMaterial(
      {
        userId: otherUserId,
        connectionId: `${connectionId}-2`,
        courseId: `${courseId}-2`,
        courseUrl: 'https://canvas.school.edu/courses/2',
      },
      'Biology OR NEAR plan work is not shared.',
      'https://canvas.school.edu/courses/2/files/biology-reading',
    );

    const passages = searchCourseMaterialPassages({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'Biology OR NEAR("plan" "work")',
    });

    expect(passages?.passages).toMatchObject([
      {
        materialId: saved?.material.id,
        version: saved?.material.contentHash,
        title: 'Biology reading',
        locator: null,
        sourceUrl: materialUrl,
      },
    ]);
    expect(passages?.passages[0]?.heading).toBe('Mitochondria');
  });

  it('benchmarks scoped FTS retrieval with twenty-five thousand synthetic passages', () => {
    const saved = writeMaterial()!;
    const insertChunk = db.$client.prepare(
      `INSERT INTO course_material_chunks
        (id, material_id, version, ordinal, heading, locator, text, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPassages = db.$client.transaction(() => {
      for (let index = 1; index <= 25_000; index += 1) {
        const relevant = index % 1000 === 0;
        insertChunk.run(
          `benchmark-passage-${index}`,
          saved.material.id,
          saved.material.contentHash,
          index,
          relevant ? 'Cell energy' : 'Course notes',
          `paragraph-${index}`,
          relevant
            ? `Mitochondria convert glucose into ATP in this biology passage ${index}.`
            : `This synthetic biology note records a course concept and detail ${index}.`,
          materialUrl,
        );
      }
    });
    insertPassages();

    const startedAt = performance.now();
    const results = searchCourseMaterialPassages({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'mitochondria ATP',
    });
    const elapsedMs = performance.now() - startedAt;

    expect(results?.passages.length).toBeGreaterThan(0);
    expect(results?.passages).toHaveLength(8);
    console.info(
      `Context search over 25,000 synthetic passages: ${elapsedMs.toFixed(2)} ms`,
    );
  });

  it('treats FTS operators and punctuation as search text instead of query syntax', () => {
    writeMaterial();

    expect(
      searchCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        query: '" OR * MATCH NEAR: x)',
      }),
    ).toMatchObject({ passages: [], truncated: false });
  });

  it('reads only selected current-version passages scoped to the account and course', () => {
    const first = writeMaterial()!;
    const oldPassage = searchCourseMaterialPassages({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'mitochondria',
    })!.passages[0]!;
    const changed = writeMaterial(
      undefined,
      '# Mitochondria\nBiology OR NEAR plan work changes cellular energy.',
    )!;

    expect(changed.material.id).toBe(first.material.id);
    expect(
      readCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        selections: [{ id: oldPassage.id, version: oldPassage.version }],
      }),
    ).toEqual([]);
    const currentPassage = searchCourseMaterialPassages({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'cellular energy',
    })!.passages[0]!;
    expect(
      readCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        selections: [
          { id: currentPassage.id, version: currentPassage.version },
        ],
      }),
    ).toMatchObject([{ text: expect.stringContaining('cellular energy') }]);
    expect(
      readCourseMaterialPassages({
        userId: otherUserId,
        connectionId: `${connectionId}-2`,
        courseId: `${courseId}-2`,
        selections: [
          { id: currentPassage.id, version: currentPassage.version },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps historical passages explicit and requires an owned saved citation', () => {
    const first = writeMaterial(
      undefined,
      '# Mitochondria\nMitochondria power the cell.',
    )!;
    const reference = {
      sourceKind: 'course-material' as const,
      sourceId: first.material.id,
      versionId: first.material.contentHash,
      courseId: `${courseId}-1`,
      locator: null,
      title: first.material.title,
      provenance: 'connected-source' as const,
      observedAt: timestamp,
      state: 'historical' as const,
    };
    writeMaterial(
      undefined,
      '# Cellular Energy\nCellular energy is stored as ATP.',
    );
    db.insert(StudySourceReferenceTable)
      .values({
        id: 'saved-material-reference',
        userId,
        sessionId: 'study-session',
        messageId: 'study-message',
        sourceKind: 'course-material',
        sourceId: reference.sourceId,
        versionId: reference.versionId,
        locator: null,
        state: 'historical',
      })
      .run();

    expect(
      searchCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        query: 'mitochondria',
      })?.passages.map(({ version }) => version),
    ).toEqual([]);
    expect(readHistoricalMaterialCitation({ userId }, reference)).toMatchObject(
      {
        reference: { sourceId: reference.sourceId, state: 'historical' },
        text: expect.stringContaining('Mitochondria power the cell.'),
        score: null,
      },
    );
    expect(
      readHistoricalMaterialCitation({ userId: otherUserId }, reference),
    ).toBeNull();

    db.$client
      .prepare(
        'UPDATE academic_connections SET is_course_resource = 0 WHERE id = ?',
      )
      .run(`${connectionId}-1`);

    expect(readHistoricalMaterialCitation({ userId }, reference)).toMatchObject(
      { reference: { state: 'removed' } },
    );

    db.$client
      .prepare(
        'UPDATE academic_connections SET is_course_resource = 1 WHERE id = ?',
      )
      .run(`${connectionId}-1`);
    db.update(CourseTable)
      .set({ suppressionId: 'suppressed-course', suppressedAt: timestamp })
      .where(eq(CourseTable.id, `${courseId}-1`))
      .run();
    expect(readHistoricalMaterialCitation({ userId }, reference)).toMatchObject(
      { reference: { state: 'removed' } },
    );
    db.update(CourseTable)
      .set({ suppressionId: null, suppressedAt: null })
      .where(eq(CourseTable.id, `${courseId}-1`))
      .run();
    db.update(CourseMaterialTable)
      .set({ suppressionId: 'suppressed-material', suppressedAt: timestamp })
      .where(eq(CourseMaterialTable.id, reference.sourceId))
      .run();
    expect(readHistoricalMaterialCitation({ userId }, reference)).toMatchObject(
      { reference: { state: 'removed' } },
    );
  });

  it('bounds FTS result count and passage characters at their schema limits', () => {
    writeMaterial();
    expect(
      searchCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        query: 'mitochondria',
        limit: 1,
        maxCharacters: 5,
      }),
    ).toMatchObject({ characters: 5, truncated: true });
    expect(
      searchCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        query: 'mitochondria',
        maxCharacters: 0,
      }),
    ).toMatchObject({ passages: [], characters: 0, truncated: true });
    expect(
      searchCourseMaterialPassages({
        userId,
        connectionId: `${connectionId}-1`,
        courseId: `${courseId}-1`,
        query: 'mitochondria',
        limit: 9,
      }),
    ).toBeNull();
  });

  it('returns existing assignment identity aliases under the authenticated course', () => {
    const assignmentUrl = `${courseUrl}/assignments/17`;
    db.insert(CourseAssignmentTable)
      .values({
        id: 'assignment-local-17',
        userId,
        courseId: `${courseId}-1`,
        sourceKey: 'id:17',
        title: 'Weekly Reflection',
        body: 'Write about week one.',
        dateValue: null,
        dateText: null,
        url: assignmentUrl,
        active: true,
        lastSeenAt: timestamp,
        content: {
          title: 'Weekly Reflection',
          description: 'Write about week one.',
          kind: 'assignment',
          state: 'active-unsubmitted',
          due: null,
          availableFrom: null,
          availableUntil: null,
          pointsPossible: null,
          url: assignmentUrl,
          sourceId: '17',
          resources: [],
          evidence: {
            sourceUrl: `${courseUrl}/assignments`,
            excerpts: ['Weekly Reflection 17'],
            targetIds: [],
          },
        },
        contentChangedAt: null,
      })
      .run();

    const identities = getExistingResourceIdentities({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      kind: 'assignments',
    });

    expect(identities).toMatchObject([
      {
        id: 'assignment-local-17',
        state: 'active-unsubmitted',
        title: 'Weekly Reflection',
        url: assignmentUrl,
      },
    ]);
    expect(identities?.[0]?.aliases).toContain(`url:${assignmentUrl}`);
  });

  it('keeps navigation and academic context separately bounded and reports omissions', () => {
    writeMaterial();
    const navigation = saveNavigationLocation(userId, `${connectionId}-1`, {
      courseId: `${courseId}-1`,
      purpose: 'materials',
      destinationUrl: 'https://canvas.school.edu/courses/1/modules',
      parentUrl: courseUrl,
      label: 'Modules',
      evidence: {
        sourceUrl: courseUrl,
        excerpts: ['Modules'],
        targetIds: [],
      },
      status: 'verified',
      destinationKind: 'collection',
    });
    const navigationContext = getNavigationContextForTask({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      purpose: 'materials',
    });
    const search = searchCourseMaterialPassages({
      userId,
      connectionId: `${connectionId}-1`,
      courseId: `${courseId}-1`,
      query: 'biology mitochondria',
    });
    const context = createAcademicContextPackage({
      navigation: navigationContext,
      search,
      maxAcademicCharacters: 20,
    });

    expect(navigation).not.toBeNull();
    expect(search?.retrievalMs).toEqual(expect.any(Number));
    expect(context?.navigation.truncated).toBe(false);
    expect(context?.academic.truncated).toBe(true);
    expect(context?.academic.characters).toBeLessThanOrEqual(20);
    expect(context?.academic.retrievalMs).toBe(search?.retrievalMs);
    expect(context?.academic.passages[0]?.version).toBe(
      search?.passages[0]?.version,
    );
  });
});
