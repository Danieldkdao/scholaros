import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  ProductPreferences,
} from '@scholaros/services/learning/product-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-study-delete-'));
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
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  AssistanceLedgerTable,
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseTable,
  CourseMaterialTable,
  LearningObservationTable,
  MemoryTable,
  PracticeAnswerTable,
  PracticeAttemptTable,
  SettingTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
  StudyTurnTable,
} = await import('../../../db/schema');
const { createSessionStore } = await import('../services/session-store');
const { registerStudySessionOperation } =
  await import('../services/session-events');

const owner = 'delete-student';
const courseId = 'delete-course';
const now = '2026-05-01T12:00:00.000Z';
const context: AuthorizedContext = {
  userId: owner,
  epoch: 3,
  isCurrent: () => true,
  signal: new AbortController().signal,
};
const cleanedStorageKeys: string[] = [];
const store = createSessionStore({
  database: db,
  now: () => Date.parse(now),
  cleanupOriginals: async (_context, _userId, storageKeys) => {
    cleanedStorageKeys.push(...storageKeys);
  },
});

const createSession = (contextItemIds: string[] = []) =>
  store.createStudySession(context, {
    requestId: randomUUID(),
    courseId,
    activity: 'practice-knowledge',
    targetAssignmentId: null,
    topic: 'Practice cell biology',
    contextItemIds,
    durationMinutes: 20,
    title: 'Delete me later',
  });

const insertContextItem = (
  id: string,
  options: {
    retainedInLibrary?: boolean;
    courseLink?: boolean;
    sessionId?: string;
    originatingSessionId?: string | null;
    storageKey?: string | null;
  } = {},
) => {
  db.insert(ContextItemTable)
    .values({
      id,
      userId: owner,
      title: id,
      kind: 'document',
      provenance: 'user-uploaded',
      currentVersionId: `version-${id}`,
      status: 'complete',
      revision: 0,
      removedAt: null,
      originatingSessionId: options.originatingSessionId ?? null,
      originatingSourceId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(ContextVersionTable)
    .values({
      id: `version-${id}`,
      userId: owner,
      itemId: id,
      attemptId: `attempt-${id}`,
      originalHash: `original-${id}`,
      contentHash: `content-${id}`,
      mimeType: 'application/pdf',
      byteLength: 1024,
      originalStorageKey: options.storageKey ?? null,
      extractedText: `Source text for ${id}`,
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: 1,
      interpretedPages: [],
      locators: [],
      createdAt: now,
    })
    .run();
  if (options.sessionId || options.courseLink)
    db.insert(ContextLinkTable)
      .values({
        id: `link-${id}-${options.sessionId ?? 'course'}`,
        userId: owner,
        itemId: id,
        courseId: options.courseLink ? courseId : null,
        sessionId: options.sessionId ?? null,
        retainedInLibrary: options.retainedInLibrary ?? false,
        createdAt: now,
      })
      .run();
};

const resetData = () => {
  cleanedStorageKeys.length = 0;
  db.delete(StudySourceReferenceTable).run();
  db.delete(StudyMessageTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(AssistanceLedgerTable).run();
  db.delete(LearningObservationTable).run();
  db.delete(PracticeAnswerTable).run();
  db.delete(PracticeAttemptTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(ArtifactStateTable).run();
  db.delete(ArtifactVersionTable).run();
  db.delete(ArtifactTable).run();
  db.delete(MemoryTable).run();
  db.delete(ContextChunkTable).run();
  db.delete(ContextVersionTable).run();
  db.delete(ContextLinkTable).run();
  db.delete(ContextItemTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseTable).run();
  db.delete(SettingTable).run();
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId: owner,
      connectionId: null,
      sourceKey: `manual:${courseId}`,
      sourceName: 'Manual',
      sourceHost: '',
      externalId: null,
      name: 'Biology',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: '',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
};

beforeEach(() => {
  resetData();
});

describe('session deletion fences', () => {
  it('cancels session-owned work and prevents a late turn commit from resurrecting the transcript', async () => {
    const created = await createSession();
    const turn = await store.beginStudyTurn(context, {
      sessionId: created.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'A pending student question',
      attachmentIds: [],
    });
    const controller = new AbortController();
    const unregister = registerStudySessionOperation(
      context,
      created.id,
      turn.turnId,
      controller,
    );
    const latestSession = await store.getStudySession(context, {
      sessionId: created.id,
    });

    await store.deleteStudySession(context, {
      sessionId: created.id,
      expectedRevision: latestSession!.session.revision,
      requestId: randomUUID(),
    });
    unregister();

    expect(controller.signal.aborted).toBe(true);
    await expect(
      store.commitStudyTurn(context, {
        turnId: turn.turnId,
        generationEpoch: turn.generationEpoch,
        policyRevision: turn.policyRevision,
        contextRevision: turn.contextRevision,
        parts: [{ kind: 'text', text: 'Late tutor response' }],
        sourceReferences: [],
        gradeDerived: false,
        gradeConsentRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'session-changed' });
    expect(
      await store.getStudySession(context, { sessionId: created.id }),
    ).toBeNull();
    expect(await store.listStudySessions(context, {})).toMatchObject({
      items: [],
    });
    expect(db.select().from(StudySessionTable).get()?.deletedAt).toBeTruthy();
    expect(db.select().from(StudyMessageTable).all()).toEqual([]);
    expect(db.select().from(StudyTurnTable).all()).toMatchObject([
      {
        id: turn.turnId,
        payloadHash: 'deleted',
        status: 'cancelled',
        errorCode: 'session-changed',
      },
    ]);
    expect(db.select().from(StudySourceReferenceTable).all()).toEqual([]);
  });

  it('removes unretained session uploads while preserving independently retained context and learning data', async () => {
    const created = await createSession();
    insertContextItem('session-upload', {
      sessionId: created.id,
      originatingSessionId: created.id,
      storageKey: 'account-storage/session-upload.pdf',
    });
    insertContextItem('saved-course-note', {
      courseLink: true,
      sessionId: created.id,
      retainedInLibrary: true,
      originatingSessionId: created.id,
    });
    insertContextItem('session-only-file', {
      sessionId: created.id,
      originatingSessionId: created.id,
      storageKey: 'account-storage/session-only.pdf',
    });
    const attemptId = 'retained-practice-attempt';
    db.insert(PracticeAttemptTable)
      .values({
        id: attemptId,
        userId: owner,
        courseId,
        sessionId: created.id,
        artifactId: null,
        versionId: 'practice-version',
        objectiveIds: [],
        mode: 'quiz',
        feedbackMode: 'end',
        status: 'evaluated',
        assisted: false,
        priorAttemptId: null,
        rubricVersion: 'rubric-v1',
        questionSet: [
          {
            id: 'q1',
            kind: 'short-explanation',
            prompt: 'What is mitosis?',
            options: null,
            unit: null,
            objectiveIds: [],
            sourceReferences: [],
          },
        ],
        hostAnswerKey: [],
        revision: 1,
        startedAt: now,
        submittedAt: now,
      })
      .run();
    db.insert(PracticeAnswerTable)
      .values({
        id: 'retained-answer',
        userId: owner,
        attemptId,
        questionId: 'q1',
        revision: 1,
        answer: { text: 'Cell division' },
        assisted: false,
        evaluation: null,
        createdAt: now,
      })
      .run();
    db.insert(LearningObservationTable)
      .values({
        id: 'retained-observation',
        userId: owner,
        courseId,
        conceptId: null,
        attemptId,
        sourceSessionId: created.id,
        kind: 'practice-response',
        responseOutcome: 'independent-success',
        assisted: false,
        independentEvidence: true,
        confidence: 0.8,
        evidenceSummary: { summary: 'Answered a practice question correctly.' },
        createdAt: now,
        revokedAt: null,
      })
      .run();
    db.insert(MemoryTable)
      .values({
        id: 'retained-memory',
        userId: owner,
        courseId,
        type: 'explicit-preference',
        content: { field: 'explanation-length', value: 'concise' },
        provenance: 'student-explicit',
        evidenceIds: [],
        confidence: null,
        revision: 1,
        supersedesId: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(ArtifactTable)
      .values({
        id: 'saved-artifact',
        userId: owner,
        courseId,
        currentVersionId: 'saved-artifact-v1',
        originatingSessionId: created.id,
        title: 'Saved graph',
        objective: 'Review cell division',
        retained: true,
        revision: 1,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(ArtifactVersionTable)
      .values({
        id: 'saved-artifact-v1',
        artifactId: 'saved-artifact',
        userId: owner,
        contentDigest: 'digest',
        html: '<p>Saved</p>',
        css: '',
        javascript: '',
        runtimeVersion: 1,
        sourceReferences: [],
        policyDecision: { allowed: true },
        createdAt: now,
      })
      .run();
    db.insert(ArtifactStateTable)
      .values({
        id: 'saved-artifact-state',
        userId: owner,
        artifactId: 'saved-artifact',
        versionId: 'saved-artifact-v1',
        attemptId: 'saved-artifact-attempt',
        stateRevision: 1,
        state: { x: 2 },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const latest = await store.getStudySession(context, {
      sessionId: created.id,
    });

    await store.deleteStudySession(context, {
      sessionId: created.id,
      expectedRevision: latest!.session.revision,
      requestId: randomUUID(),
    });

    expect(db.select().from(ContextItemTable).get()?.id).toBe(
      'saved-course-note',
    );
    expect(
      db
        .select()
        .from(ContextItemTable)
        .all()
        .map((item) => item.id),
    ).toEqual(['saved-course-note']);
    expect(db.select().from(ContextLinkTable).all()).toMatchObject([
      expect.objectContaining({
        itemId: 'saved-course-note',
        sessionId: null,
        courseId,
        retainedInLibrary: true,
      }),
    ]);
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .map((version) => version.itemId),
    ).toEqual(['saved-course-note']);
    expect(db.select().from(PracticeAttemptTable).get()).toMatchObject({
      id: attemptId,
      sessionId: null,
    });
    expect(db.select().from(PracticeAnswerTable).all()).toHaveLength(1);
    expect(db.select().from(LearningObservationTable).get()).toMatchObject({
      id: 'retained-observation',
      sourceSessionId: null,
      attemptId,
    });
    expect(db.select().from(MemoryTable).get()?.id).toBe('retained-memory');
    expect(db.select().from(ArtifactTable).get()).toMatchObject({
      id: 'saved-artifact',
      originatingSessionId: null,
      retained: true,
    });
    expect(cleanedStorageKeys).toEqual([
      'account-storage/session-only.pdf',
      'account-storage/session-upload.pdf',
    ]);
  });

  it('keeps upload cleanup retryable when local storage deletion fails', async () => {
    const created = await createSession();
    insertContextItem('cleanup-retry-upload', {
      sessionId: created.id,
      originatingSessionId: created.id,
      storageKey: 'account-storage/retry-upload.pdf',
    });
    const latest = await store.getStudySession(context, {
      sessionId: created.id,
    });
    let failCleanup = true;
    const retryStore = createSessionStore({
      database: db,
      now: () => Date.parse(now),
      cleanupOriginals: async (_context, _userId, storageKeys) => {
        if (failCleanup) throw new Error('Local storage is temporarily busy.');
        cleanedStorageKeys.push(...storageKeys);
      },
    });
    const deleteInput = {
      sessionId: created.id,
      expectedRevision: latest!.session.revision,
      requestId: randomUUID(),
    };

    await expect(
      retryStore.deleteStudySession(context, deleteInput),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(db.select().from(StudySessionTable).get()?.deletedAt).toBeTruthy();
    expect(db.select().from(ContextItemTable).all()).toMatchObject([
      expect.objectContaining({ id: 'cleanup-retry-upload' }),
    ]);
    expect(db.select().from(ContextVersionTable).all()).toMatchObject([
      expect.objectContaining({
        itemId: 'cleanup-retry-upload',
        originalStorageKey: 'account-storage/retry-upload.pdf',
      }),
    ]);

    failCleanup = false;
    await retryStore.deleteStudySession(context, deleteInput);

    expect(db.select().from(ContextItemTable).all()).toEqual([]);
    expect(cleanedStorageKeys).toContain('account-storage/retry-upload.pdf');
  });

  it('purges grade-derived history while preserving ordinary messages and unrelated local learning data', async () => {
    const prefs: ProductPreferences = {
      grades: { enabled: true, notes: '', revision: 4 },
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
    db.insert(SettingTable)
      .values({ userId: owner, productPreferences: prefs, updatedAt: now })
      .run();
    const created = await createSession();
    db.insert(CourseMaterialTable)
      .values({
        id: 'unrelated-course-material',
        userId: owner,
        connectionId: 'course-connection',
        courseId,
        sourceIdentity: 'material:mitosis',
        url: 'https://schoology.example/course/materials/mitosis',
        title: 'Mitosis notes',
        sourceType: 'syllabus',
        contentHash: 'material-v1',
        currentUsableVersion: 'material-v1',
        extractionStatus: 'complete',
        completeness: 100,
        summary: null,
        summaryEvidence: null,
        retrievedAt: now,
        verifiedAt: now,
        contentChangedAt: now,
        lastAttemptAt: now,
        active: true,
        suppressionId: null,
        suppressedAt: null,
      })
      .run();
    db.insert(PracticeAttemptTable)
      .values({
        id: 'unrelated-practice-attempt',
        userId: owner,
        courseId,
        sessionId: null,
        artifactId: null,
        versionId: 'practice-version',
        objectiveIds: [],
        mode: 'quiz',
        feedbackMode: 'end',
        status: 'evaluated',
        assisted: false,
        priorAttemptId: null,
        rubricVersion: 'rubric-v1',
        questionSet: [],
        hostAnswerKey: [],
        revision: 1,
        startedAt: now,
        submittedAt: now,
      })
      .run();
    db.insert(StudyMessageTable)
      .values([
        {
          id: 'grade-derived-message',
          userId: owner,
          sessionId: created.id,
          sequence: 0,
          turnId: null,
          role: 'tutor',
          status: 'accepted',
          parts: [
            { kind: 'text', text: 'Your grade suggests reviewing mitosis.' },
          ],
          gradeDerived: true,
          gradeConsentRevision: 4,
          createdAt: now,
        },
        {
          id: 'ordinary-message',
          userId: owner,
          sessionId: created.id,
          sequence: 1,
          turnId: null,
          role: 'tutor',
          status: 'accepted',
          parts: [
            { kind: 'text', text: 'Mitosis creates two daughter cells.' },
          ],
          gradeDerived: false,
          gradeConsentRevision: null,
          createdAt: now,
        },
      ])
      .run();
    db.insert(StudySourceReferenceTable)
      .values([
        {
          id: 'grade-reference',
          userId: owner,
          sessionId: created.id,
          messageId: 'grade-derived-message',
          sourceKind: 'grade-evidence',
          sourceId: 'grade-1',
          versionId: null,
          locator: null,
          state: 'current',
        },
        {
          id: 'course-reference',
          userId: owner,
          sessionId: created.id,
          messageId: 'ordinary-message',
          sourceKind: 'course-material',
          sourceId: 'material-1',
          versionId: 'material-version-1',
          locator: null,
          state: 'current',
        },
      ])
      .run();
    db.update(SettingTable)
      .set({
        productPreferences: {
          ...prefs,
          grades: { enabled: false, notes: '', revision: 5 },
        },
      })
      .where(eq(SettingTable.userId, owner))
      .run();
    const revisionBeforePurge = db
      .select({ revision: StudySessionTable.revision })
      .from(StudySessionTable)
      .where(eq(StudySessionTable.id, created.id))
      .get()?.revision;

    await store.purgeGradeDerivedStudyContent(context, { consentRevision: 5 });
    const snapshot = await store.getStudySession(context, {
      sessionId: created.id,
    });
    const messages = db.select().from(StudyMessageTable).all();

    expect(snapshot?.messages[0]?.parts).toEqual([
      {
        kind: 'status',
        code: 'grade-content-removed',
        label: 'Grade-derived study content was removed.',
      },
    ]);
    expect(snapshot?.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'Mitosis creates two daughter cells.' },
    ]);
    expect(messages[0]).toMatchObject({
      id: 'grade-derived-message',
      gradeDerived: false,
      gradeConsentRevision: null,
    });
    expect(
      db
        .select()
        .from(StudySourceReferenceTable)
        .all()
        .map((item) => item.id),
    ).toEqual(['course-reference']);
    expect(
      db.select().from(SettingTable).get()?.productPreferences.grades,
    ).toMatchObject({
      enabled: false,
      revision: 5,
    });
    expect(db.select().from(CourseMaterialTable).get()?.id).toBe(
      'unrelated-course-material',
    );
    expect(db.select().from(PracticeAttemptTable).get()?.id).toBe(
      'unrelated-practice-attempt',
    );
    expect(db.select().from(StudySessionTable).get()?.revision).toBe(
      revisionBeforePurge! + 1,
    );
  });

  it('refuses another account deletion and leaves that account session intact', async () => {
    const created = await createSession();
    const latest = await store.getStudySession(context, {
      sessionId: created.id,
    });

    await expect(
      store.deleteStudySession(
        { ...context, userId: 'other-student' },
        {
          sessionId: created.id,
          expectedRevision: latest!.session.revision,
          requestId: randomUUID(),
        },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(
      await store.getStudySession(context, { sessionId: created.id }),
    ).not.toBeNull();
  });
});
