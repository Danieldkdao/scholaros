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
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';

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
        contextItemIds: [],
        durationMinutes: null,
      });
      const admitted = await fixtureStore.beginStudyTurn(fixtureContext, {
        sessionId: created.id,
        requestId: randomUUID(),
        expectedDraftRevision: 0,
        text: 'Explain mitosis.',
        attachmentIds: [],
      });
      await fixtureStore.commitStudyTurn(fixtureContext, {
        turnId: admitted.turnId,
        generationEpoch: admitted.generationEpoch,
        policyRevision: admitted.policyRevision,
        contextRevision: admitted.contextRevision,
        parts: [{ kind: 'text', text: 'Mitosis creates two daughter cells.' }],
        sourceReferences: [],
        gradeDerived: false,
        gradeConsentRevision: null,
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
          [{ kind: 'text', text: 'Mitosis creates two daughter cells.' }],
        ]);
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
