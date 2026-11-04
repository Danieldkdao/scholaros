import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  AuthorizedRegistrar,
  ProductPreferences,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { MessagePart } from '@scholaros/services/learning/study-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-study-store-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
  };
  return { app, default: { app } };
});

const { db } = await import('../../../db');
const {
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAssignmentTable,
  CourseTable,
  GradeEvidenceTable,
  SettingTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
  StudyTurnTable,
} = await import('../../../db/schema');
const schema = await import('../../../db/schema');
const { studyActivities } =
  await import('@scholaros/services/learning/study-contracts');
const { createSessionStore } = await import('../services/session-store');
const { registerSessionActions } = await import('../services/session-actions');
const { registerStudySessionOperation, hasStudySessionOperation } =
  await import('../services/session-events');

const owner = 'student-a';
const otherOwner = 'student-b';
const biologyCourseId = 'course-biology';
const chemistryCourseId = 'course-chemistry';
const now = '2026-03-08T07:55:00.000Z';
const publishedEvents: ProductEventV1[] = [];
const store = createSessionStore({
  database: db,
  now: () => Date.parse(now),
  publish: (event) => publishedEvents.push(event),
});
const accountContext = (userId = owner): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const insertCourse = (id: string, userId = owner) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId,
      connectionId: null,
      sourceKey: `manual:${id}`,
      sourceName: 'Manual',
      sourceHost: '',
      externalId: null,
      name: id === biologyCourseId ? 'Biology' : 'Chemistry',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: '',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();

const insertAssignment = (id: string, courseId: string, userId = owner) =>
  db
    .insert(CourseAssignmentTable)
    .values({
      id,
      userId,
      courseId,
      sourceKey: `manual:${id}`,
      title: 'Cell study guide',
      body: null,
      dateValue: null,
      dateText: null,
      url: '',
      lastSeenAt: now,
    })
    .run();

const insertContextItem = (
  id: string,
  userId = owner,
  courseId: string | null = null,
) => {
  db.insert(ContextItemTable)
    .values({
      id,
      userId,
      title: id,
      kind: 'document',
      provenance: 'user-uploaded',
      currentVersionId: `version-${id}`,
      status: 'complete',
      revision: 0,
      removedAt: null,
      originatingSessionId: null,
      originatingSourceId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(ContextVersionTable)
    .values({
      id: `version-${id}`,
      userId,
      itemId: id,
      attemptId: `attempt-${id}`,
      originalHash: `original-${id}`,
      contentHash: `content-${id}`,
      mimeType: 'text/plain',
      byteLength: 16,
      originalStorageKey: null,
      extractedText: 'Local study notes',
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: null,
      interpretedPages: [],
      locators: [],
      createdAt: now,
    })
    .run();
  if (courseId)
    db.insert(ContextLinkTable)
      .values({
        id: `course-link-${id}`,
        userId,
        itemId: id,
        courseId,
        sessionId: null,
        retainedInLibrary: true,
        createdAt: now,
      })
      .run();
};

const createInput = (overrides: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  courseId: biologyCourseId,
  activity: 'understand-topic' as const,
  targetAssignmentId: null,
  topic: 'Cell division',
  contextItemIds: [],
  durationMinutes: 30,
  title: 'Cell division review',
  ...overrides,
});

const createMigratedAppendFixture = async (gradeConsent?: {
  enabled: boolean;
  revision: number;
}) => {
  const fixtureDirectory = mkdtempSync(
    join(tmpdir(), 'scholaros-study-effects-'),
  );
  const databasePath = join(fixtureDirectory, 'study.sqlite');
  const client = new Database(databasePath);
  const database = drizzle({ client, schema });
  const fixtureContext = accountContext('effects-student');
  const fixtureCourseId = 'effects-course';
  const sourceReference: SourceReference = {
    sourceKind: 'assignment',
    sourceId: 'effects-assignment',
    versionId: null,
    courseId: fixtureCourseId,
    locator: null,
    title: 'Cell study guide',
    provenance: 'connected-source',
    observedAt: now,
    state: 'current',
  };
  const events: ProductEventV1[] = [];
  const visibleMessageCountsAtPublish: number[] = [];

  try {
    migrate(database, {
      migrationsFolder: join(process.cwd(), 'src', 'db', 'migrations'),
    });
    database
      .insert(CourseTable)
      .values({
        id: fixtureCourseId,
        userId: fixtureContext.userId,
        connectionId: null,
        sourceKey: `manual:${fixtureCourseId}`,
        sourceName: 'Manual',
        sourceHost: '',
        externalId: null,
        name: 'Effects course',
        code: null,
        term: null,
        instructor: null,
        description: null,
        url: '',
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    database
      .insert(CourseAssignmentTable)
      .values({
        id: sourceReference.sourceId,
        userId: fixtureContext.userId,
        courseId: fixtureCourseId,
        sourceKey: `manual:${sourceReference.sourceId}`,
        title: sourceReference.title,
        body: null,
        dateValue: null,
        dateText: null,
        url: '',
        lastSeenAt: now,
      })
      .run();
    if (gradeConsent) {
      const productPreferences: ProductPreferences = {
        grades: { ...gradeConsent, notes: '' },
        notifications: {
          enabled: false,
          categories: {
            'connection-attention': false,
            'sync-completed': false,
            'sync-failed': false,
            'context-completed': false,
            'context-failed': false,
            'tutor-ready': false,
            'activity-ready': false,
            'timer-expired': false,
            'deadline-reminder': false,
          },
          quietHours: {
            enabled: false,
            startMinute: 1320,
            endMinute: 480,
            timeZone: 'UTC',
          },
          revision: 0,
        },
        learning: {
          educationLevel: null,
          appearance: 'system',
          accessibility: { reduceMotion: false, highContrast: false },
          revision: 0,
        },
      };
      database
        .insert(SettingTable)
        .values({
          userId: fixtureContext.userId,
          productPreferences,
          updatedAt: now,
        })
        .run();
      database
        .insert(GradeEvidenceTable)
        .values({
          id: 'effects-grade-evidence',
          userId: fixtureContext.userId,
          connectionId: 'effects-connection',
          courseId: fixtureCourseId,
          assignmentIdentity: 'effects-assignment',
          sourceVersion: 'effects-grade-v1',
          observedAt: now,
          consentRevision: gradeConsent.revision,
          completed: 'unknown',
          grade: null,
          remainingOpportunity: 'unknown',
          conflicts: [],
          sourceReferences: [],
          revokedAt: null,
        })
        .run();
    }

    const fixtureStore = createSessionStore({
      database,
      now: () => Date.parse(now),
      publish: (event) => {
        events.push(event);
        const observer = new Database(databasePath, { readonly: true });
        try {
          const result = observer
            .prepare(
              'SELECT COUNT(*) AS count FROM study_messages WHERE user_id = ?',
            )
            .get(fixtureContext.userId) as { count: number };
          visibleMessageCountsAtPublish.push(result.count);
        } finally {
          observer.close();
        }
      },
    });
    const created = await fixtureStore.createStudySession(
      fixtureContext,
      createInput({
        requestId: randomUUID(),
        courseId: fixtureCourseId,
        durationMinutes: null,
      }),
    );
    const turn = await fixtureStore.beginStudyTurn(fixtureContext, {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [],
    });
    const commitTutorTurn = (
      options: {
        parts?: MessagePart[];
        sourceReferences?: SourceReference[];
        gradeDerived?: boolean;
        gradeConsentRevision?: number | null;
      } = {},
    ) =>
      fixtureStore.commitStudyTurn(fixtureContext, {
        turnId: turn.turnId,
        generationEpoch: turn.generationEpoch,
        policyRevision: turn.policyRevision,
        contextRevision: turn.contextRevision,
        parts: options.parts ?? [
          { kind: 'text', text: 'Mitosis creates two daughter cells.' },
        ],
        sourceReferences: options.sourceReferences ?? [],
        gradeDerived: options.gradeDerived ?? false,
        gradeConsentRevision: options.gradeConsentRevision ?? null,
      });

    return {
      context: fixtureContext,
      database,
      events,
      sessionId: created.id,
      sourceReference,
      store: fixtureStore,
      turn,
      visibleMessageCountsAtPublish,
      commitTutorTurn,
      close: () => {
        if (client.open) client.close();
        rmSync(fixtureDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (client.open) client.close();
    rmSync(fixtureDirectory, { recursive: true, force: true });
    throw error;
  }
};

const withMigratedAppendFixture = async (
  run: (
    fixture: Awaited<ReturnType<typeof createMigratedAppendFixture>>,
  ) => Promise<void>,
  gradeConsent?: { enabled: boolean; revision: number },
) => {
  const fixture = await createMigratedAppendFixture(gradeConsent);
  try {
    await run(fixture);
  } finally {
    fixture.close();
  }
};

const resetStudyData = () => {
  publishedEvents.length = 0;
  db.$client.exec('DROP TRIGGER IF EXISTS fail_study_message');
  db.delete(StudySourceReferenceTable).run();
  db.delete(StudyMessageTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(ContextChunkTable).run();
  db.delete(ContextVersionTable).run();
  db.delete(ContextLinkTable).run();
  db.delete(ContextItemTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseTable).run();
  db.delete(SettingTable).run();
  insertCourse(biologyCourseId);
  insertCourse(chemistryCourseId);
  insertCourse('course-other-account', otherOwner);
  insertAssignment('assignment-biology', biologyCourseId);
  insertAssignment('assignment-chemistry', chemistryCourseId);
  insertAssignment('assignment-other-account', biologyCourseId, otherOwner);
};

beforeEach(() => {
  resetStudyData();
});

describe('creating study sessions', () => {
  it.each(studyActivities)(
    'creates the %s activity with one course',
    async (activity) => {
      const created = await store.createStudySession(
        accountContext(),
        createInput({ activity }),
      );

      expect(created).toMatchObject({
        courseId: biologyCourseId,
        activity,
        status: 'saved',
        targetAssignmentId: null,
        topic: 'Cell division',
        draft: { text: '', revision: 0 },
        timer: { revision: 0, expiredRevision: null },
      });
      expect(created.timer.deadlineAt).toBe('2026-03-08T08:25:00.000Z');
      expect(
        db
          .select()
          .from(StudySessionTable)
          .all()
          .map((session) => session.courseId),
      ).toEqual([biologyCourseId]);
    },
  );

  it('replays a create request without duplicating a session and rejects changed payloads', async () => {
    const input = createInput();
    const created = await store.createStudySession(accountContext(), input);
    const replayed = await store.createStudySession(accountContext(), input);

    expect(replayed.id).toBe(created.id);
    expect(db.select().from(StudySessionTable).all()).toHaveLength(1);
    await expect(
      store.createStudySession(accountContext(), {
        ...input,
        topic: 'A different topic',
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('accepts an assignment only when it belongs to the selected course and account', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput({
        activity: 'assignment-start',
        targetAssignmentId: 'assignment-biology',
      }),
    );

    expect(created.targetAssignmentId).toBe('assignment-biology');
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({
          requestId: randomUUID(),
          targetAssignmentId: 'assignment-chemistry',
        }),
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({
          requestId: randomUUID(),
          targetAssignmentId: 'assignment-other-account',
        }),
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });

  it('rejects arrays, unknown fields, unavailable courses and invalid durations', async () => {
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({ courseId: [biologyCourseId, chemistryCourseId] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({ courseIds: [biologyCourseId, chemistryCourseId] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({ courseId: 'missing-course' }),
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({ durationMinutes: 241 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('attaches optional unassigned uploads without authorizing another course', async () => {
    insertContextItem('personal-notes');
    insertContextItem('chemistry-notes', owner, chemistryCourseId);
    const created = await store.createStudySession(
      accountContext(),
      createInput({ contextItemIds: ['personal-notes'] }),
    );

    expect(db.select().from(ContextLinkTable).all()).toContainEqual(
      expect.objectContaining({
        itemId: 'personal-notes',
        sessionId: created.id,
        courseId: biologyCourseId,
        retainedInLibrary: false,
      }),
    );
    await expect(
      store.createStudySession(
        accountContext(),
        createInput({
          requestId: randomUUID(),
          contextItemIds: ['chemistry-notes'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      store.createStudySession(
        accountContext(otherOwner),
        createInput({
          requestId: randomUUID(),
          contextItemIds: ['personal-notes'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });
});

describe('reading and updating history', () => {
  it('returns empty pages and isolates every account/session lookup', async () => {
    const empty = await store.listStudySessions(accountContext(), {});

    expect(empty).toMatchObject({ items: [], nextCursor: null });
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );

    expect(
      await store.listStudySessions(accountContext(otherOwner), {}),
    ).toMatchObject({
      items: [],
      nextCursor: null,
    });
    expect(
      await store.getStudySession(accountContext(otherOwner), {
        sessionId: created.id,
      }),
    ).toBeNull();
    expect(
      await store.getStudySession(accountContext(), {
        sessionId: 'missing-session',
      }),
    ).toBeNull();
  });

  it('searches, filters and paginates with a stable opaque cursor', async () => {
    await store.createStudySession(
      accountContext(),
      createInput({ title: 'Cell division notes' }),
    );
    await store.createStudySession(
      accountContext(),
      createInput({ requestId: randomUUID(), title: 'Cell membrane review' }),
    );
    await store.createStudySession(
      accountContext(),
      createInput({
        requestId: randomUUID(),
        courseId: chemistryCourseId,
        title: 'Cell chemistry',
      }),
    );
    await store.createStudySession(
      accountContext(),
      createInput({
        requestId: randomUUID(),
        title: 'Unrelated topic',
        topic: 'Unrelated topic',
      }),
    );

    const firstPage = await store.listStudySessions(accountContext(), {
      query: 'cell',
      courseId: biologyCourseId,
      limit: 1,
    });
    if (!firstPage)
      throw new Error('The first session page could not be read.');
    const secondPage = await store.listStudySessions(accountContext(), {
      query: 'cell',
      courseId: biologyCourseId,
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    if (!secondPage)
      throw new Error('The second session page could not be read.');

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      await store.listStudySessions(accountContext(), {
        limit: 1,
        cursor: 'not-a-cursor',
      }),
    ).toBeNull();
  });

  it('renames with compare-and-swap and preserves newer session fields', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const draft = await store.saveStudyDraft(accountContext(), {
      sessionId: created.id,
      text: 'Keep this draft',
      expectedDraftRevision: 0,
    });
    const latest = await store.getStudySession(accountContext(), {
      sessionId: created.id,
    });
    if (!latest) throw new Error('The updated session could not be read.');
    const renamed = await store.renameStudySession(accountContext(), {
      sessionId: created.id,
      title: 'New title',
      expectedRevision: latest.session.revision,
    });

    expect(draft.draftRevision).toBe(1);
    expect(renamed).toMatchObject({
      title: 'New title',
      draft: { text: 'Keep this draft', revision: 1 },
    });
    await expect(
      store.renameStudySession(accountContext(), {
        sessionId: created.id,
        title: 'Stale title',
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('saves drafts by revision and ignores a late autosave after a newer draft', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const first = await store.saveStudyDraft(accountContext(), {
      sessionId: created.id,
      text: 'Newest text',
      expectedDraftRevision: 0,
    });

    expect(first.draftRevision).toBe(1);
    await expect(
      store.saveStudyDraft(accountContext(), {
        sessionId: created.id,
        text: 'Late older text',
        expectedDraftRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    const snapshot = await store.getStudySession(accountContext(), {
      sessionId: created.id,
    });

    expect(snapshot?.session.draft).toEqual({
      text: 'Newest text',
      revision: 1,
    });
  });

  it('restores the latest bounded transcript in sequence order and supports older paging', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const insertMessage = db.$client.prepare(`
      INSERT INTO study_messages (
        id, user_id, session_id, sequence, turn_id, role, status, parts,
        grade_derived, grade_consent_revision, created_at
      ) VALUES (?, ?, ?, ?, NULL, 'student', 'accepted', ?, 0, NULL, ?)
    `);
    for (let sequence = 0; sequence < 105; sequence++)
      insertMessage.run(
        `message-${sequence}`,
        owner,
        created.id,
        sequence,
        JSON.stringify([{ kind: 'text', text: `Message ${sequence}` }]),
        now,
      );

    const recent = await store.getStudySession(accountContext(), {
      sessionId: created.id,
    });
    const older = await store.getStudySession(accountContext(), {
      sessionId: created.id,
      beforeSequence: 5,
      limit: 100,
    });

    expect(recent?.messages).toHaveLength(100);
    expect(recent?.messages[0]?.sequence).toBe(5);
    expect(recent?.messages.at(-1)?.sequence).toBe(104);
    expect(recent?.hasMoreBefore).toBe(true);
    expect(older?.messages.map((message) => message.sequence)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(older?.hasMoreBefore).toBe(false);
  });
});

describe('durable turn admission', () => {
  it('persists the student message and turn once before inference', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const input = {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [] as string[],
    };
    const accepted = await store.beginStudyTurn(accountContext(), input);
    const replayed = await store.beginStudyTurn(accountContext(), input);

    expect(replayed).toMatchObject({
      turnId: accepted.turnId,
      generationEpoch: accepted.generationEpoch,
      duplicate: true,
    });
    expect(db.select().from(StudyTurnTable).all()).toHaveLength(1);
    expect(db.select().from(StudyMessageTable).all()).toHaveLength(1);
    expect(db.select().from(StudyMessageTable).get()).toMatchObject({
      role: 'student',
      status: 'accepted',
      parts: [{ kind: 'text', text: 'Explain mitosis.' }],
    });
  });

  it('rejects request-ID reuse with a changed payload and rejects stale draft revisions', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const requestId = randomUUID();
    await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId,
      expectedDraftRevision: 0,
      text: 'First request',
      attachmentIds: [],
    });

    await expect(
      store.beginStudyTurn(accountContext(), {
        sessionId: created.id,
        requestId,
        expectedDraftRevision: 0,
        text: 'Changed request',
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(
      store.beginStudyTurn(accountContext(), {
        sessionId: created.id,
        requestId: randomUUID(),
        expectedDraftRevision: 1,
        text: 'Stale draft',
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    expect(db.select().from(StudyMessageTable).all()).toHaveLength(1);
  });

  it('validates attachment ownership and accepted message-part bounds', async () => {
    insertContextItem('owned-upload');
    insertContextItem('other-account-upload', otherOwner);
    const created = await store.createStudySession(
      accountContext(),
      createInput({ contextItemIds: ['owned-upload'] }),
    );

    const accepted = await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: '',
      attachmentIds: ['owned-upload'],
    });
    expect(accepted.turnId).toBeTruthy();
    await store.settleStudyTurn(accountContext(), {
      turnId: accepted.turnId,
      status: 'cancelled',
    });
    await expect(
      store.beginStudyTurn(accountContext(), {
        sessionId: created.id,
        requestId: randomUUID(),
        expectedDraftRevision: 1,
        text: 'No cross-account attachments',
        attachmentIds: ['other-account-upload'],
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });

  it('rolls back turn admission when the student-message write fails', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    db.$client.exec(`
      CREATE TRIGGER fail_study_message BEFORE INSERT ON study_messages
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;
    `);

    await expect(
      store.beginStudyTurn(accountContext(), {
        sessionId: created.id,
        requestId: randomUUID(),
        expectedDraftRevision: 0,
        text: 'Do not lose this request.',
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(db.select().from(StudyTurnTable).all()).toEqual([]);
    expect(db.select().from(StudyMessageTable).all()).toEqual([]);
  });

  it('commits tutor parts and source references only for the captured current revision', async () => {
    insertContextItem('source-item');
    const created = await store.createStudySession(
      accountContext(),
      createInput({ contextItemIds: ['source-item'] }),
    );
    const turn = await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [],
    });
    const reference = {
      sourceKind: 'context-version' as const,
      sourceId: 'source-item',
      versionId: 'version-source-item',
      courseId: biologyCourseId,
      locator: null,
      title: 'source-item',
      provenance: 'user-uploaded' as const,
      observedAt: now,
      state: 'current' as const,
    };
    const committed = await store.commitStudyTurn(accountContext(), {
      turnId: turn.turnId,
      generationEpoch: turn.generationEpoch,
      policyRevision: turn.policyRevision,
      contextRevision: turn.contextRevision,
      parts: [
        { kind: 'text', text: 'Mitosis produces two daughter cells.' },
        { kind: 'citation', reference },
      ],
      sourceReferences: [reference],
      gradeDerived: false,
      gradeConsentRevision: null,
    });

    expect(committed.status).toBe('complete');
    const snapshot = await store.getStudySession(accountContext(), {
      sessionId: created.id,
    });
    expect(
      snapshot?.messages.map((message) => [message.sequence, message.role]),
    ).toEqual([
      [0, 'student'],
      [1, 'tutor'],
    ]);
    expect(snapshot?.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'Mitosis produces two daughter cells.' },
      { kind: 'citation', reference },
    ]);
    expect(snapshot?.sourceReferences).toEqual([reference]);
  });

  it('publishes session invalidation only after the create transaction commits', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );

    expect(publishedEvents).toContainEqual(
      expect.objectContaining({
        accountId: owner,
        resource: 'study',
        targetId: created.id,
        revision: created.revision,
      }),
    );
  });

  it('rejects a second active turn while replaying the original request idempotently', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const firstTurn = {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [],
    };
    const admitted = await store.beginStudyTurn(accountContext(), firstTurn);

    await expect(
      store.beginStudyTurn(accountContext(), firstTurn),
    ).resolves.toMatchObject({
      turnId: admitted.turnId,
      duplicate: true,
    });
    await expect(
      store.beginStudyTurn(accountContext(), {
        ...firstTurn,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('retries one logical turn idempotently without duplicating its student message', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const firstTurn = await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [],
    });
    await store.settleStudyTurn(accountContext(), {
      turnId: firstTurn.turnId,
      status: 'failed',
      errorCode: 'provider-failed',
    });
    const retryRequestId = randomUUID();
    const retryInput = {
      sessionId: created.id,
      turnId: firstTurn.turnId,
      requestId: retryRequestId,
    };
    const retried = await store.retryStudyTurn(accountContext(), retryInput);
    const replayed = await store.retryStudyTurn(accountContext(), retryInput);
    const unregister = registerStudySessionOperation(
      accountContext(),
      created.id,
      retried.turnId,
      new AbortController(),
    );
    const retriedSnapshot = await store.getStudySession(accountContext(), {
      sessionId: created.id,
    });
    unregister();

    expect(retried).toMatchObject({
      turnId: firstTurn.turnId,
      duplicate: false,
      turn: { status: 'preparing', attemptNumber: 2 },
    });
    expect(replayed).toMatchObject({
      turnId: firstTurn.turnId,
      duplicate: true,
    });
    expect(
      retriedSnapshot?.messages.filter((message) => message.role === 'student'),
    ).toHaveLength(1);
    expect(db.select().from(StudyTurnTable).all()).toHaveLength(1);

    await store.settleStudyTurn(accountContext(), {
      turnId: firstTurn.turnId,
      status: 'cancelled',
    });
    const secondTurn = await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain meiosis.',
      attachmentIds: [],
    });
    await store.settleStudyTurn(accountContext(), {
      turnId: secondTurn.turnId,
      status: 'failed',
    });
    await expect(
      store.retryStudyTurn(accountContext(), {
        sessionId: created.id,
        turnId: secondTurn.turnId,
        requestId: retryRequestId,
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('rejects citations embedded in a response unless their exact source is authorized', async () => {
    const created = await store.createStudySession(
      accountContext(),
      createInput(),
    );
    const turn = await store.beginStudyTurn(accountContext(), {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain mitosis.',
      attachmentIds: [],
    });
    const foreignReference = {
      sourceKind: 'context-version' as const,
      sourceId: 'foreign-item',
      versionId: 'foreign-version',
      courseId: chemistryCourseId,
      locator: null,
      title: 'Foreign notes',
      provenance: 'user-uploaded' as const,
      observedAt: now,
      state: 'current' as const,
    };

    await expect(
      store.commitStudyTurn(accountContext(), {
        turnId: turn.turnId,
        generationEpoch: turn.generationEpoch,
        policyRevision: turn.policyRevision,
        contextRevision: turn.contextRevision,
        parts: [{ kind: 'citation', reference: foreignReference }],
        sourceReferences: [],
        gradeDerived: false,
        gradeConsentRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });

  it('registers only the stable study public methods and returns a cleanup callback', async () => {
    const handlers = new Map<string, unknown>();
    const registrar = {
      handle: (name: string, handler: unknown) => handlers.set(name, handler),
      publish: vi.fn(),
      lifecycle: {
        signal: new AbortController().signal,
        epoch: 1,
        isCurrent: () => true,
        now: () => Date.parse(now),
        registerOperation: () => () => undefined,
        onTeardown: vi.fn(),
      },
    } as unknown as AuthorizedRegistrar;

    const cleanup = registerSessionActions(registrar, { store });

    expect([...handlers.keys()].sort()).toEqual(
      [
        'createStudySession',
        'deleteStudySession',
        'extendStudySession',
        'finishStudySession',
        'getStudySession',
        'listStudySessions',
        'reconcileStudyDeadline',
        'renameStudySession',
        'saveStudyDraft',
        'continueStudyUntimed',
      ].sort(),
    );
    expect(cleanup).toEqual(expect.any(Function));
    await cleanup();
  });

  it('cleans up aborted session operations before restart reconciliation', () => {
    const sessionId = randomUUID();
    const accountController = new AbortController();
    const context = {
      ...accountContext(),
      signal: accountController.signal,
    };
    const operationId = randomUUID();
    const operationController = new AbortController();
    const unregisterOperation = registerStudySessionOperation(
      context,
      sessionId,
      operationId,
      operationController,
    );
    expect(
      hasStudySessionOperation(context.userId, sessionId, operationId),
    ).toBe(true);

    operationController.abort();
    expect(
      hasStudySessionOperation(context.userId, sessionId, operationId),
    ).toBe(false);
    unregisterOperation();

    const accountOperationId = randomUUID();
    const accountOperationController = new AbortController();
    const unregisterAccountOperation = registerStudySessionOperation(
      context,
      sessionId,
      accountOperationId,
      accountOperationController,
    );
    accountController.abort();
    expect(accountOperationController.signal.aborted).toBe(true);
    expect(
      hasStudySessionOperation(context.userId, sessionId, accountOperationId),
    ).toBe(false);
    unregisterAccountOperation();
  });

  it('restores ordered session messages after reopening an actual migrated fixture database', async () => {
    const fixtureDirectory = mkdtempSync(
      join(tmpdir(), 'scholaros-study-restart-'),
    );
    const databasePath = join(fixtureDirectory, 'study.sqlite');
    const fixtureCourseId = 'restart-course';
    const fixtureContext = accountContext('restart-student');
    const fixtureDate = '2026-03-08T07:55:00.000Z';
    const firstClient = new Database(databasePath);
    const firstDatabase = drizzle({ client: firstClient, schema });

    try {
      migrate(firstDatabase, {
        migrationsFolder: join(process.cwd(), 'src', 'db', 'migrations'),
      });
      firstDatabase
        .insert(CourseTable)
        .values({
          id: fixtureCourseId,
          userId: fixtureContext.userId,
          connectionId: null,
          sourceKey: `manual:${fixtureCourseId}`,
          sourceName: 'Manual',
          sourceHost: '',
          externalId: null,
          name: 'Restart course',
          code: null,
          term: null,
          instructor: null,
          description: null,
          url: '',
          firstSeenAt: fixtureDate,
          lastSeenAt: fixtureDate,
        })
        .run();
      firstDatabase
        .insert(ContextItemTable)
        .values({
          id: 'restart-source-item',
          userId: fixtureContext.userId,
          title: 'Restart source',
          kind: 'document',
          provenance: 'user-uploaded',
          currentVersionId: 'restart-source-version',
          status: 'complete',
          revision: 0,
          removedAt: null,
          originatingSessionId: null,
          originatingSourceId: null,
          createdAt: fixtureDate,
          updatedAt: fixtureDate,
        })
        .run();
      firstDatabase
        .insert(ContextVersionTable)
        .values({
          id: 'restart-source-version',
          userId: fixtureContext.userId,
          itemId: 'restart-source-item',
          attemptId: 'restart-source-attempt',
          originalHash: 'restart-source-original',
          contentHash: 'restart-source-content',
          mimeType: 'text/plain',
          byteLength: 16,
          originalStorageKey: null,
          extractedText: 'Chromosomes separate during mitosis.',
          extractionStatus: 'complete',
          uncertainty: null,
          pageCount: null,
          interpretedPages: [],
          locators: [],
          createdAt: fixtureDate,
        })
        .run();
      const fixtureStore = createSessionStore({
        database: firstDatabase,
        now: () => Date.parse(fixtureDate),
      });
      const created = await fixtureStore.createStudySession(fixtureContext, {
        requestId: randomUUID(),
        courseId: fixtureCourseId,
        activity: 'understand-topic',
        targetAssignmentId: null,
        topic: 'Cell division',
        contextItemIds: ['restart-source-item'],
        durationMinutes: null,
      });
      const admitted = await fixtureStore.beginStudyTurn(fixtureContext, {
        sessionId: created.id,
        requestId: randomUUID(),
        expectedDraftRevision: 0,
        text: 'Explain mitosis.',
        attachmentIds: [],
      });
      const sourceReference = {
        sourceKind: 'context-version' as const,
        sourceId: 'restart-source-item',
        versionId: 'restart-source-version',
        courseId: fixtureCourseId,
        locator: null,
        title: 'Restart source',
        provenance: 'user-uploaded' as const,
        observedAt: fixtureDate,
        state: 'current' as const,
      };
      await fixtureStore.commitStudyTurn(fixtureContext, {
        turnId: admitted.turnId,
        generationEpoch: admitted.generationEpoch,
        policyRevision: admitted.policyRevision,
        contextRevision: admitted.contextRevision,
        parts: [
          { kind: 'text', text: 'Mitosis creates two daughter cells.' },
          { kind: 'citation', reference: sourceReference },
          {
            kind: 'activity',
            artifactId: 'restart-artifact',
            versionId: 'restart-version',
            attemptId: 'restart-attempt',
          },
          { kind: 'practice', practiceAttemptId: 'restart-practice' },
          {
            kind: 'status',
            code: 'preference-saved',
            label: 'Saved a preference.',
          },
        ],
        sourceReferences: [sourceReference],
        gradeDerived: false,
        gradeConsentRevision: null,
      });
      await fixtureStore.saveStudyDraft(fixtureContext, {
        sessionId: created.id,
        text: 'Review cytokinesis next.',
        expectedDraftRevision: 0,
      });
      const interruptedSession = await fixtureStore.createStudySession(
        fixtureContext,
        {
          requestId: randomUUID(),
          courseId: fixtureCourseId,
          activity: 'understand-topic',
          targetAssignmentId: null,
          topic: 'Cell division',
          contextItemIds: [],
          durationMinutes: null,
        },
      );
      const interruptedTurn = await fixtureStore.beginStudyTurn(
        fixtureContext,
        {
          sessionId: interruptedSession.id,
          requestId: randomUUID(),
          expectedDraftRevision: 0,
          text: 'Explain meiosis.',
          attachmentIds: [],
        },
      );
      firstClient.close();

      const reopenedClient = new Database(databasePath);
      try {
        const reopenedDatabase = drizzle({ client: reopenedClient, schema });
        const reopenedStore = createSessionStore({
          database: reopenedDatabase,
          now: () => Date.parse(fixtureDate),
        });
        const snapshot = await reopenedStore.getStudySession(fixtureContext, {
          sessionId: created.id,
        });

        expect(snapshot?.messages.map((message) => message.parts)).toEqual([
          [{ kind: 'text', text: 'Explain mitosis.' }],
          [
            { kind: 'text', text: 'Mitosis creates two daughter cells.' },
            { kind: 'citation', reference: sourceReference },
            {
              kind: 'activity',
              artifactId: 'restart-artifact',
              versionId: 'restart-version',
              attemptId: 'restart-attempt',
            },
            { kind: 'practice', practiceAttemptId: 'restart-practice' },
            {
              kind: 'status',
              code: 'preference-saved',
              label: 'Saved a preference.',
            },
          ],
        ]);
        expect(snapshot?.sourceReferences).toEqual([sourceReference]);
        expect(snapshot?.session.draft).toEqual({
          text: 'Review cytokinesis next.',
          revision: 1,
        });
        const interruptedSnapshot = await reopenedStore.getStudySession(
          fixtureContext,
          {
            sessionId: interruptedSession.id,
          },
        );
        expect(interruptedSnapshot?.activeTurn).toBeNull();
        expect(interruptedSnapshot?.session.status).toBe('interrupted');
        expect(
          interruptedSnapshot?.messages.find(
            (message) => message.turnId === interruptedTurn.turnId,
          ),
        ).toMatchObject({ role: 'student', status: 'interrupted' });
        expect(
          reopenedDatabase
            .select()
            .from(StudyTurnTable)
            .all()
            .find((turn) => turn.id === interruptedTurn.turnId),
        ).toMatchObject({ status: 'cancelled' });
        const retried = await reopenedStore.retryStudyTurn(fixtureContext, {
          sessionId: interruptedSession.id,
          turnId: interruptedTurn.turnId,
          requestId: randomUUID(),
        });
        expect(retried).toMatchObject({
          turnId: interruptedTurn.turnId,
          turn: { status: 'preparing', attemptNumber: 2 },
        });
      } finally {
        reopenedClient.close();
      }
    } finally {
      if (firstClient.open) firstClient.close();
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});

describe('durable tutor effect append', () => {
  it('appends validated parts only after the tutor turn is committed', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      const input = {
        sessionId: fixture.sessionId,
        turnId: fixture.turn.turnId,
        generationEpoch: fixture.turn.generationEpoch,
        idempotencyKey: 'effects-turn:0:first-effect',
        parts: [
          { kind: 'text', text: 'Review the phases in order.' },
          { kind: 'citation', reference: fixture.sourceReference },
        ] satisfies MessagePart[],
      };

      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, input),
      ).rejects.toMatchObject({ code: 'revision-conflict' });
      expect(await fixture.commitTutorTurn()).toMatchObject({
        status: 'complete',
      });
      const beforeAppend = await fixture.store.getStudySession(
        fixture.context,
        { sessionId: fixture.sessionId },
      );
      if (!beforeAppend)
        throw new Error('The committed session was not found.');

      const result = await fixture.store.appendStudyTurnParts(
        fixture.context,
        input,
      );
      const snapshot = await fixture.store.getStudySession(fixture.context, {
        sessionId: fixture.sessionId,
      });

      expect(result).toEqual({
        committed: true,
        revision: beforeAppend.session.revision + 1,
      });
      expect(
        snapshot?.messages.map(({ sequence, role }) => [sequence, role]),
      ).toEqual([
        [0, 'student'],
        [1, 'tutor'],
        [2, 'tutor'],
      ]);
      expect(snapshot?.messages.at(-1)).toMatchObject({
        turnId: fixture.turn.turnId,
        status: 'accepted',
        parts: input.parts,
        gradeDerived: false,
        gradeConsentRevision: null,
      });
      expect(snapshot?.sourceReferences).toEqual([fixture.sourceReference]);
      expect(fixture.visibleMessageCountsAtPublish.at(-1)).toBe(3);
      expect(fixture.events.at(-1)).toMatchObject({
        targetId: fixture.sessionId,
        revision: result.revision,
      });
    });
  });

  it('replays identical effects once and preserves later effect order', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      await fixture.commitTutorTurn();
      const input = {
        sessionId: fixture.sessionId,
        turnId: fixture.turn.turnId,
        generationEpoch: fixture.turn.generationEpoch,
        idempotencyKey: 'effects-turn:0:replay',
        parts: [
          { kind: 'citation', reference: fixture.sourceReference },
        ] satisfies MessagePart[],
      };

      const first = await fixture.store.appendStudyTurnParts(
        fixture.context,
        input,
      );
      const eventCountAfterFirstAppend = fixture.events.length;
      const replayed = await fixture.store.appendStudyTurnParts(
        fixture.context,
        input,
      );
      const nextEffect = await fixture.store.appendStudyTurnParts(
        fixture.context,
        {
          ...input,
          idempotencyKey: 'effects-turn:1:replay-order',
          parts: [
            { kind: 'text', text: 'Then review cytokinesis.' },
          ] satisfies MessagePart[],
        },
      );
      const snapshot = await fixture.store.getStudySession(fixture.context, {
        sessionId: fixture.sessionId,
      });

      expect(replayed).toEqual(first);
      expect(nextEffect.revision).toBe(first.revision + 1);
      expect(
        snapshot?.messages.filter(
          (message) =>
            message.turnId === fixture.turn.turnId && message.role === 'tutor',
        ),
      ).toMatchObject([
        {
          parts: [
            { kind: 'text', text: 'Mitosis creates two daughter cells.' },
          ],
        },
        { parts: input.parts },
        { parts: [{ kind: 'text', text: 'Then review cytokinesis.' }] },
      ]);
      expect(snapshot?.sourceReferences).toEqual([fixture.sourceReference]);
      expect(fixture.events).toHaveLength(eventCountAfterFirstAppend + 1);
    });
  });

  it('rejects reuse of an idempotency key with different parts', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      await fixture.commitTutorTurn();
      const input = {
        sessionId: fixture.sessionId,
        turnId: fixture.turn.turnId,
        generationEpoch: fixture.turn.generationEpoch,
        idempotencyKey: 'effects-turn:0:payload-conflict',
        parts: [
          { kind: 'text', text: 'Review mitosis.' },
        ] satisfies MessagePart[],
      };

      await fixture.store.appendStudyTurnParts(fixture.context, input);
      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, {
          ...input,
          parts: [{ kind: 'text', text: 'Review meiosis.' }],
        }),
      ).rejects.toMatchObject({ code: 'revision-conflict' });
      const snapshot = await fixture.store.getStudySession(fixture.context, {
        sessionId: fixture.sessionId,
      });

      expect(
        snapshot?.messages.filter((message) => message.role === 'tutor'),
      ).toHaveLength(2);
      expect(snapshot?.messages.at(-1)?.parts).toEqual(input.parts);
    });
  });

  it('rejects malformed message parts without writing an effect', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      await fixture.commitTutorTurn();

      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, {
          sessionId: fixture.sessionId,
          turnId: fixture.turn.turnId,
          generationEpoch: fixture.turn.generationEpoch,
          idempotencyKey: 'effects-turn:0:invalid-parts',
          parts: [{ kind: 'unknown-part' }] as unknown as MessagePart[],
        }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      expect(
        fixture.database.select().from(StudyMessageTable).all(),
      ).toHaveLength(2);
    });
  });

  it('rejects stale epochs, another account, and deleted sessions', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      await fixture.commitTutorTurn();
      const input = {
        sessionId: fixture.sessionId,
        turnId: fixture.turn.turnId,
        generationEpoch: fixture.turn.generationEpoch,
        idempotencyKey: 'effects-turn:0:stale-scope',
        parts: [
          { kind: 'text', text: 'Review cell division.' },
        ] satisfies MessagePart[],
      };

      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, {
          ...input,
          generationEpoch: input.generationEpoch + 1,
        }),
      ).rejects.toMatchObject({ code: 'session-changed' });
      await expect(
        fixture.store.appendStudyTurnParts(
          accountContext('effects-other-student'),
          input,
        ),
      ).rejects.toMatchObject({ code: 'not-found' });
      await expect(
        fixture.store.appendStudyTurnParts(
          { ...fixture.context, isCurrent: () => false },
          input,
        ),
      ).rejects.toMatchObject({ code: 'session-changed' });
      const snapshot = await fixture.store.getStudySession(fixture.context, {
        sessionId: fixture.sessionId,
      });
      if (!snapshot) throw new Error('The committed session was not found.');
      await fixture.store.deleteStudySession(fixture.context, {
        sessionId: fixture.sessionId,
        expectedRevision: snapshot.session.revision,
        requestId: randomUUID(),
      });

      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, input),
      ).rejects.toMatchObject({ code: 'session-changed' });
      expect(
        await fixture.store.getStudySession(fixture.context, {
          sessionId: fixture.sessionId,
        }),
      ).toBeNull();
      expect(fixture.database.select().from(StudyMessageTable).all()).toEqual(
        [],
      );
    });
  });

  it('rejects appending to a cancelled turn', async () => {
    await withMigratedAppendFixture(async (fixture) => {
      await fixture.store.settleStudyTurn(fixture.context, {
        turnId: fixture.turn.turnId,
        status: 'cancelled',
      });

      await expect(
        fixture.store.appendStudyTurnParts(fixture.context, {
          sessionId: fixture.sessionId,
          turnId: fixture.turn.turnId,
          generationEpoch: fixture.turn.generationEpoch,
          idempotencyKey: 'effects-turn:0:cancelled',
          parts: [{ kind: 'text', text: 'This must not be saved.' }],
        }),
      ).rejects.toMatchObject({ code: 'cancelled' });
      expect(
        fixture.database
          .select()
          .from(StudyMessageTable)
          .all()
          .filter((message) => message.role === 'tutor'),
      ).toEqual([]);
    });
  });

  it('validates grade citations against current evidence and consent on replay', async () => {
    await withMigratedAppendFixture(
      async (fixture) => {
        await fixture.commitTutorTurn();
        const gradeReference: SourceReference = {
          sourceKind: 'grade-evidence',
          sourceId: 'effects-grade-evidence',
          versionId: null,
          courseId: 'effects-course',
          locator: null,
          title: 'Recent biology grade',
          provenance: 'connected-source',
          observedAt: now,
          state: 'current',
        };
        const input = {
          sessionId: fixture.sessionId,
          turnId: fixture.turn.turnId,
          generationEpoch: fixture.turn.generationEpoch,
          idempotencyKey: 'effects-turn:0:grade-citation',
          parts: [
            { kind: 'citation', reference: gradeReference },
          ] satisfies MessagePart[],
        };

        await expect(
          fixture.store.appendStudyTurnParts(fixture.context, {
            ...input,
            idempotencyKey: 'effects-turn:0:missing-grade',
            parts: [
              {
                kind: 'citation',
                reference: {
                  ...gradeReference,
                  sourceId: 'missing-grade-evidence',
                },
              },
            ],
          }),
        ).rejects.toMatchObject({ code: 'permission-revoked' });

        const appended = await fixture.store.appendStudyTurnParts(
          fixture.context,
          input,
        );
        const gradeMessage = fixture.database
          .select()
          .from(StudyMessageTable)
          .all()
          .find(
            (message) =>
              message.turnId === fixture.turn.turnId &&
              message.role === 'tutor' &&
              JSON.stringify(message.parts) === JSON.stringify(input.parts),
          );
        expect(appended.committed).toBe(true);
        expect(gradeMessage).toMatchObject({
          gradeDerived: true,
          gradeConsentRevision: 4,
          parts: input.parts,
        });
        fixture.database.$client
          .prepare('UPDATE grade_evidence SET revoked_at = ? WHERE id = ?')
          .run(now, gradeReference.sourceId);

        await expect(
          fixture.store.appendStudyTurnParts(fixture.context, input),
        ).rejects.toMatchObject({ code: 'permission-revoked' });
        expect(
          fixture.database.select().from(StudyMessageTable).all(),
        ).toHaveLength(3);
      },
      { enabled: true, revision: 4 },
    );
  });
});

it('rolls back tutor text and effect links together when completing the turn fails', async () => {
  await withMigratedAppendFixture(async (fixture) => {
    const eventCount = fixture.events.length;
    fixture.database.$client.exec(`
      CREATE TRIGGER fail_effect_completion BEFORE UPDATE OF status ON study_turns
      WHEN NEW.status = 'complete'
      BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END;
    `);
    await expect(
      fixture.commitTutorTurn({
        parts: [
          { kind: 'text', text: 'A safe conceptual explanation.' },
          {
            kind: 'activity',
            artifactId: 'rollback-artifact',
            versionId: 'rollback-version',
            attemptId: 'rollback-attempt',
          },
          { kind: 'practice', practiceAttemptId: 'rollback-practice' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    const observer = new Database(fixture.database.$client.name, {
      readonly: true,
    });
    try {
      expect(
        observer
          .prepare(
            "SELECT COUNT(*) AS count FROM study_messages WHERE role = 'tutor'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        observer
          .prepare('SELECT status FROM study_turns WHERE id = ?')
          .get(fixture.turn.turnId),
      ).toEqual({ status: 'preparing' });
      expect(fixture.events).toHaveLength(eventCount);
    } finally {
      observer.close();
    }
  });
});
