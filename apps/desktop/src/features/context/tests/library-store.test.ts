import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => {
  appState.userData = mkdtempSync(
    path.join(tmpdir(), 'scholaros-context-store-'),
  );
  return {
    app: {
      getPath: () => appState.userData,
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
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
} = await import('../../../db/schema');
const { createOriginalStore } = await import('../services/original-store');
const { registerContextActions } = await import('../services/library-actions');
const {
  createUploadedContextItem,
  createContextNote,
  deleteAllContextForAccount,
  getContextItem,
  listContextItems,
  linkContextItem,
  releaseContextSession,
  removeContextItem,
  resolveHistoricalContextCitation,
  saveGeneratedContextItem,
  saveContextIngestionResult,
  setContextIngestionStatus,
  updateContextItem,
} = await import('../services/library-store');

type AuthorizedContext = {
  userId: string;
  epoch: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

const userId = 'context-store-student';
const courseId = 'context-store-course';
const sessionId = 'context-store-session';
const now = '2026-11-03T12:00:00.000Z';
const controller = new AbortController();
const context: AuthorizedContext = {
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: controller.signal,
};
const originalStore = createOriginalStore();

const insertCourse = (id: string, accountId = userId) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId: accountId,
      connectionId: null,
      sourceKey: `manual-${id}`,
      sourceName: 'Manual',
      sourceHost: 'local',
      externalId: null,
      name: `Course ${id}`,
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: 'https://example.edu/course',
      firstSeenAt: now,
      lastSeenAt: now,
      contentChangedAt: null,
      overviewSyncedAt: null,
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    })
    .run();

const insertSession = (
  id: string,
  accountId = userId,
  selectedCourseId = courseId,
) =>
  db
    .insert(StudySessionTable)
    .values({
      id,
      userId: accountId,
      courseId: selectedCourseId,
      title: 'Study session',
      activity: 'understand-topic',
      targetAssignmentId: null,
      topic: null,
      status: 'saved',
      revision: 0,
      generationEpoch: 0,
      draftText: '',
      draftRevision: 0,
      deadlineAt: null,
      timerRevision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    })
    .run();

const countFts = (query: string) =>
  (
    db.$client
      .prepare(
        'SELECT COUNT(*) AS count FROM context_chunks_fts WHERE context_chunks_fts MATCH ?',
      )
      .get(query) as { count: number }
  ).count;

beforeEach(async () => {
  db.delete(StudySourceReferenceTable).run();
  db.delete(StudyMessageTable).run();
  db.delete(ContextChunkTable).run();
  db.delete(ContextLinkTable).run();
  db.delete(ContextVersionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(CourseTable).run();
  await rm(path.join(appState.userData, 'context-originals'), {
    recursive: true,
    force: true,
  });
  insertCourse(courseId);
  insertSession(sessionId);
});

afterAll(async () => {
  db.$client.close();
  await rm(appState.userData, { recursive: true, force: true });
});

describe('Context library store', () => {
  it('creates an unassigned note without inventing a connected course or material', async () => {
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Cell notes',
      text: 'Mitochondria produce cellular energy.',
      kind: 'note',
    });

    expect(note).toMatchObject({
      title: 'Cell notes',
      kind: 'note',
      provenance: 'user-authored',
      courseIds: [],
      usable: true,
      status: 'complete',
    });
    expect(db.select().from(ContextItemTable).all()).toHaveLength(1);
    expect(db.select().from(CourseTable).all()).toHaveLength(1);
    expect(db.select().from(CourseMaterialTable).all()).toHaveLength(0);
    expect(db.select().from(ContextLinkTable).all()).toMatchObject([
      { courseId: null, sessionId: null, retainedInLibrary: true },
    ]);
    expect(countFts('"Mitochondria"')).toBe(1);
  });

  it('returns a real empty page and paginates with a stable cursor', async () => {
    const emptyPage = listContextItems(context, { limit: 2 });
    expect(emptyPage).toMatchObject({ items: [], nextCursor: null });
    expect(
      listContextItems(context, { courseId: 'foreign-course' }),
    ).toBeNull();

    for (const title of ['Alpha note', 'Beta note', 'Gamma note'])
      await createContextNote(context, {
        requestId: randomUUID(),
        title,
        text: `${title} content.`,
        kind: 'note',
      });
    const firstPage = listContextItems(context, { limit: 2 });
    const secondPage = listContextItems(context, {
      limit: 2,
      cursor: firstPage?.nextCursor ?? undefined,
    });

    expect(firstPage?.items).toHaveLength(2);
    expect(firstPage?.nextCursor).not.toBeNull();
    expect(secondPage?.items).toHaveLength(1);
    expect(
      new Set([
        ...(firstPage?.items.map(({ id }) => id) ?? []),
        ...(secondPage?.items.map(({ id }) => id) ?? []),
      ]).size,
    ).toBe(3);
  });

  it('attaches and detaches a course without copying the note version', async () => {
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Lecture notes',
      text: 'Cell membranes regulate transport.',
      kind: 'note',
      courseId,
    });
    const versionIds = db
      .select()
      .from(ContextVersionTable)
      .all()
      .map(({ id }) => id);

    expect(note.courseIds).toEqual([courseId]);
    const detachedItem = await linkContextItem(context, {
      itemId: note.id,
      courseId: null,
      retainInLibrary: true,
    });

    expect(detachedItem.courseIds).toEqual([]);
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .map(({ id }) => id),
    ).toEqual(versionIds);
    expect(db.select().from(ContextLinkTable).all()).toMatchObject([
      { courseId: null, sessionId: null, retainedInLibrary: true },
    ]);
  });

  it('detaches a session association from a different course when moving an item', async () => {
    const otherCourseId = 'context-store-other-course';
    insertCourse(otherCourseId);
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Scoped session upload',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });

    const movedItem = await linkContextItem(context, {
      itemId,
      courseId: otherCourseId,
      retainInLibrary: true,
    });
    const links = db
      .select()
      .from(ContextLinkTable)
      .where(eq(ContextLinkTable.itemId, itemId))
      .all();

    expect(movedItem.courseIds).toEqual([otherCourseId]);
    expect(links.some((link) => link.sessionId === sessionId)).toBe(false);
  });

  it('retains a session upload in Context without copying its original', async () => {
    const originalBytes = Buffer.from('original document bytes');
    const original = await originalStore.write(userId, originalBytes, 10_000);
    const itemId = randomUUID();
    const versionId = randomUUID();
    db.insert(ContextItemTable)
      .values({
        id: itemId,
        userId,
        title: 'Uploaded handout',
        kind: 'document',
        provenance: 'user-uploaded',
        currentVersionId: versionId,
        status: 'complete',
        revision: 0,
        removedAt: null,
        originatingSessionId: sessionId,
        originatingSourceId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(ContextVersionTable)
      .values({
        id: versionId,
        userId,
        itemId,
        attemptId: randomUUID(),
        originalHash: original.hash,
        contentHash: createHash('sha256').update('Handout text').digest('hex'),
        mimeType: 'application/pdf',
        byteLength: original.byteLength,
        originalStorageKey: original.storageKey,
        extractedText: 'Handout text',
        extractionStatus: 'complete',
        uncertainty: null,
        pageCount: 1,
        interpretedPages: [],
        locators: [{ kind: 'page', page: 1 }],
        createdAt: now,
      })
      .run();
    db.insert(ContextChunkTable)
      .values({
        id: randomUUID(),
        userId,
        itemId,
        versionId,
        ordinal: 0,
        locator: { kind: 'page', page: 1 },
        text: 'Handout text',
      })
      .run();
    db.insert(ContextLinkTable)
      .values({
        id: randomUUID(),
        userId,
        itemId,
        courseId: null,
        sessionId,
        retainedInLibrary: false,
        createdAt: now,
      })
      .run();

    const retainedItem = await linkContextItem(context, {
      itemId,
      courseId: null,
      sessionId,
      retainInLibrary: true,
    });

    expect(retainedItem.id).toBe(itemId);
    expect(db.select().from(ContextVersionTable).all()).toHaveLength(1);
    expect(db.select().from(ContextLinkTable).all()).toMatchObject([
      { itemId, sessionId, courseId: null, retainedInLibrary: false },
      { itemId, sessionId: null, courseId: null, retainedInLibrary: true },
    ]);
    expect(await originalStore.read(userId, original.storageKey)).toEqual(
      originalBytes,
    );
    const itemDetail = await getContextItem(context, { itemId });
    expect(itemDetail?.versions[0]).toMatchObject({
      originalAvailable: true,
      mimeType: 'application/pdf',
    });
    expect(itemDetail?.preview).toMatchObject({
      kind: 'text',
      text: 'Handout text',
    });
    expect(JSON.stringify(itemDetail)).not.toContain(original.storageKey);
  });

  it('rejects a foreign course, item, or session instead of trusting caller scope', async () => {
    insertCourse('another-account-course', 'another-account');
    insertSession(
      'another-account-session',
      'another-account',
      'another-account-course',
    );
    insertSession('foreign-course-session', userId, 'another-account-course');

    await expect(
      createContextNote(context, {
        requestId: randomUUID(),
        title: 'Foreign course',
        text: 'Should not save.',
        kind: 'note',
        courseId: 'another-account-course',
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      linkContextItem(context, {
        itemId: 'foreign-item',
        courseId: null,
        sessionId: 'another-account-session',
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      saveGeneratedContextItem(context, {
        requestId: randomUUID(),
        title: 'Cross-account session',
        text: 'Must not attach to a foreign course.',
        kind: 'explanation',
        sourceId: 'session-message',
        courseId: null,
        sessionId: 'foreign-course-session',
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    expect(db.select().from(ContextItemTable).all()).toHaveLength(0);
  });

  it('writes immutable note versions and enforces the expected revision', async () => {
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Draft',
      text: 'First explanation.',
      kind: 'note',
    });
    const messageId = randomUUID();
    db.insert(StudyMessageTable)
      .values({
        id: messageId,
        userId,
        sessionId,
        sequence: 0,
        turnId: null,
        role: 'student',
        status: 'accepted',
        parts: [],
        gradeDerived: false,
        gradeConsentRevision: null,
        createdAt: now,
      })
      .run();
    db.insert(StudySourceReferenceTable)
      .values({
        id: randomUUID(),
        userId,
        sessionId,
        messageId,
        sourceKind: 'context-version',
        sourceId: note.id,
        versionId: note.currentVersionId,
        locator: null,
        state: 'current',
      })
      .run();
    const updated = await updateContextItem(context, {
      itemId: note.id,
      expectedRevision: note.revision,
      title: 'Revised draft',
      text: 'Second explanation.',
    });

    expect(updated).toMatchObject({ title: 'Revised draft', revision: 1 });
    expect(db.select().from(ContextVersionTable).all()).toHaveLength(2);
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .map(({ extractedText }) => extractedText),
    ).toEqual(['First explanation.', 'Second explanation.']);
    expect(db.select().from(StudySourceReferenceTable).all()).toMatchObject([
      { versionId: note.currentVersionId, state: 'historical' },
    ]);
    expect(
      listContextItems(context, { query: 'First explanation' })?.items,
    ).toEqual([]);
    expect(
      listContextItems(context, { query: 'Second explanation' })?.items.map(
        ({ id }: { id: string }) => id,
      ),
    ).toEqual([note.id]);
    expect(
      resolveHistoricalContextCitation(context, {
        sessionId,
        sourceId: note.id,
        versionId: note.currentVersionId!,
      }),
    ).toMatchObject({
      reference: { state: 'historical', versionId: note.currentVersionId },
      text: 'First explanation.',
    });
    await expect(
      updateContextItem(context, {
        itemId: note.id,
        expectedRevision: note.revision,
        text: 'Stale edit.',
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('removes future retrieval and leaves an explicit removed citation marker', async () => {
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Cited notes',
      text: 'Source removal marker phrase.',
      kind: 'note',
      courseId,
    });
    const versionId = note.currentVersionId!;
    const messageId = randomUUID();
    db.insert(StudyMessageTable)
      .values({
        id: messageId,
        userId,
        sessionId,
        sequence: 0,
        turnId: null,
        role: 'student',
        status: 'accepted',
        parts: [],
        gradeDerived: false,
        gradeConsentRevision: null,
        createdAt: now,
      })
      .run();
    db.insert(StudySourceReferenceTable)
      .values({
        id: randomUUID(),
        userId,
        sessionId,
        messageId,
        sourceKind: 'context-version',
        sourceId: note.id,
        versionId,
        locator: null,
        state: 'current',
      })
      .run();

    await removeContextItem(context, {
      itemId: note.id,
      expectedRevision: note.revision,
    });

    expect(db.select().from(ContextChunkTable).all()).toHaveLength(0);
    expect(db.select().from(StudySourceReferenceTable).all()).toMatchObject([
      { sourceId: note.id, versionId: null, locator: null, state: 'removed' },
    ]);
    expect(db.select().from(ContextItemTable).all()).toMatchObject([
      { id: note.id, removedAt: expect.any(String), currentVersionId: null },
    ]);
    expect(countFts('"removal"')).toBe(0);
    expect(
      resolveHistoricalContextCitation(context, {
        sessionId,
        sourceId: note.id,
        versionId,
      }),
    ).toMatchObject({
      reference: { state: 'removed', versionId: null },
      text: 'This source was removed.',
    });
  });

  it('registers only the shared Context actions and publishes after commit', async () => {
    type RegisteredAction = (
      actionContext: AuthorizedContext,
      input: unknown,
    ) => Promise<unknown>;
    const registered = new Map<string, RegisteredAction>();
    const events: unknown[] = [];
    let committedBeforePublish = false;
    const registrar = {
      handle: (name: string, handler: RegisteredAction) =>
        registered.set(name, handler),
      publish: (event: ProductEventV1) => {
        committedBeforePublish = Boolean(
          db
            .select()
            .from(ContextItemTable)
            .where(eq(ContextItemTable.id, event.targetId ?? ''))
            .get(),
        );
        events.push(event);
      },
      lifecycle: {
        signal: controller.signal,
        epoch: 1,
        isCurrent: () => true,
        now: () => Date.now(),
        registerOperation: () => () => {},
        onTeardown: () => {},
      },
    };
    const cleanup = registerContextActions(registrar as never);

    expect([...registered.keys()].sort()).toEqual([
      'createContextNote',
      'getContextItem',
      'linkContextItem',
      'listContextItems',
      'removeContextItem',
      'updateContextItem',
    ]);
    const createdContextItem = (await registered.get('createContextNote')!(
      context,
      {
        requestId: randomUUID(),
        title: 'Action-created note',
        text: 'Action payload remains a normal note.',
        kind: 'note',
      },
    )) as { id: string; revision: number };

    expect(committedBeforePublish).toBe(true);
    expect(events).toEqual([
      {
        version: 1,
        accountId: userId,
        revision: listContextItems(context, { limit: 1 })?.revision,
        resource: 'context',
        targetId: createdContextItem.id,
        outcome: 'completed',
      },
    ]);
    await cleanup();
  });

  it('deletes session-only uploads but preserves independently retained course and library items', async () => {
    const original = await originalStore.write(
      userId,
      Buffer.from('session-only original'),
      10_000,
    );
    const itemId = randomUUID();
    const versionId = randomUUID();
    db.insert(ContextItemTable)
      .values({
        id: itemId,
        userId,
        title: 'Session-only upload',
        kind: 'document',
        provenance: 'user-uploaded',
        currentVersionId: versionId,
        status: 'complete',
        revision: 0,
        removedAt: null,
        originatingSessionId: sessionId,
        originatingSourceId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(ContextVersionTable)
      .values({
        id: versionId,
        userId,
        itemId,
        attemptId: randomUUID(),
        originalHash: original.hash,
        contentHash: createHash('sha256').update('Session text').digest('hex'),
        mimeType: 'text/plain',
        byteLength: original.byteLength,
        originalStorageKey: original.storageKey,
        extractedText: 'Session text',
        extractionStatus: 'complete',
        uncertainty: null,
        pageCount: null,
        interpretedPages: [],
        locators: [],
        createdAt: now,
      })
      .run();
    db.insert(ContextChunkTable)
      .values({
        id: randomUUID(),
        userId,
        itemId,
        versionId,
        ordinal: 0,
        locator: null,
        text: 'Session text',
      })
      .run();
    db.insert(ContextLinkTable)
      .values({
        id: randomUUID(),
        userId,
        itemId,
        courseId: null,
        sessionId,
        retainedInLibrary: false,
        createdAt: now,
      })
      .run();
    const independent = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Saved course notes',
      text: 'Persist beyond the session.',
      kind: 'note',
      courseId,
    });
    const savedActivity = await saveGeneratedContextItem(context, {
      requestId: randomUUID(),
      title: 'Cell energy activity',
      text: 'A saved activity explanation.',
      kind: 'activity',
      sourceId: 'accepted-artifact-version',
      courseId,
      sessionId,
    });

    await releaseContextSession(context, { sessionId });
    const retainedActivity = await getContextItem(context, {
      itemId: savedActivity.id,
    });

    expect(retainedActivity?.item.source).toMatchObject({
      sessionId: null,
      sourceId: 'accepted-artifact-version',
    });
    expect(db.select().from(ContextItemTable).all()).toMatchObject([
      { id: itemId, removedAt: expect.any(String) },
      { id: independent.id, removedAt: null },
      { id: savedActivity.id, removedAt: null },
    ]);
    expect(
      db
        .select()
        .from(ContextItemTable)
        .all()
        .find(({ id }) => id === independent.id)?.currentVersionId,
    ).toBe(independent.currentVersionId);
    await expect(
      originalStore.read(userId, original.storageKey),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(db.select().from(ContextLinkTable).all()).toMatchObject([
      {
        itemId: independent.id,
        courseId: null,
        sessionId: null,
        retainedInLibrary: true,
      },
      {
        itemId: independent.id,
        courseId,
        sessionId: null,
        retainedInLibrary: false,
      },
      {
        itemId: savedActivity.id,
        courseId: null,
        sessionId: null,
        retainedInLibrary: true,
      },
      {
        itemId: savedActivity.id,
        courseId,
        sessionId: null,
        retainedInLibrary: false,
      },
    ]);
  });

  it('deletes only Context references and originals during scoped account cleanup', async () => {
    const orphanedOriginal = await originalStore.write(
      userId,
      Buffer.from('orphaned owned original'),
      1024,
    );
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Account cleanup note',
      text: 'Remove my Context evidence.',
      kind: 'note',
    });
    const messageId = randomUUID();
    db.insert(StudyMessageTable)
      .values({
        id: messageId,
        userId,
        sessionId,
        sequence: 0,
        turnId: null,
        role: 'student',
        status: 'accepted',
        parts: [],
        gradeDerived: false,
        gradeConsentRevision: null,
        createdAt: now,
      })
      .run();
    db.insert(StudySourceReferenceTable)
      .values([
        {
          id: randomUUID(),
          userId,
          sessionId,
          messageId,
          sourceKind: 'context-version',
          sourceId: note.id,
          versionId: note.currentVersionId,
          locator: null,
          state: 'current',
        },
        {
          id: randomUUID(),
          userId,
          sessionId,
          messageId,
          sourceKind: 'course-material',
          sourceId: 'independent-material',
          versionId: randomUUID(),
          locator: null,
          state: 'current',
        },
      ])
      .run();

    await deleteAllContextForAccount(context);

    expect(db.select().from(ContextItemTable).all()).toEqual([]);
    await expect(
      originalStore.read(userId, orphanedOriginal.storageKey),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(
      db
        .select({ sourceKind: StudySourceReferenceTable.sourceKind })
        .from(StudySourceReferenceTable)
        .all(),
    ).toEqual([{ sourceKind: 'course-material' }]);
  });

  it('retains an original-backed raw checkpoint without making it searchable', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Raw image',
      kind: 'image',
      sessionId,
      saveToLibrary: false,
    });
    const bytes = Buffer.from('raw image bytes');
    const original = await originalStore.write(userId, bytes, 1024);
    const result = await saveContextIngestionResult(context, {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: original.hash,
      contentHash: original.hash,
      mimeType: 'image/png',
      byteLength: original.byteLength,
      originalStorageKey: original.storageKey,
      extractedText: null,
      extractionStatus: 'partial',
      uncertainty: null,
      pageCount: null,
      interpretedPages: [],
      locators: [],
      originalIsNew: true,
    });
    expect(result.currentVersionId).toBeNull();
    expect(result.usable).toBe(false);
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .filter((v) => v.itemId === itemId),
    ).toHaveLength(1);
    expect(
      db
        .select()
        .from(ContextChunkTable)
        .all()
        .filter((v) => v.itemId === itemId),
    ).toHaveLength(0);
    expect(await originalStore.read(userId, original.storageKey)).toEqual(
      bytes,
    );
  });

  it('exposes a complete empty text version without indexing it', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Empty',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const original = await originalStore.write(userId, Buffer.alloc(0), 1024);
    const result = await saveContextIngestionResult(context, {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: original.hash,
      contentHash: createHash('sha256').update('').digest('hex'),
      mimeType: 'text/plain',
      byteLength: 0,
      originalStorageKey: original.storageKey,
      extractedText: '',
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: null,
      interpretedPages: [],
      locators: [],
      originalIsNew: true,
    });
    expect(result.currentVersionId).toEqual(expect.any(String));
    expect(result.usable).toBe(false);
    expect(
      db
        .select()
        .from(ContextChunkTable)
        .all()
        .filter((v) => v.itemId === itemId),
    ).toHaveLength(0);
  });

  it('cleans a newly owned original when extracted text hash is invalid', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Invalid hash',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const original = await originalStore.write(
      userId,
      Buffer.from('bad hash original'),
      1024,
    );
    await expect(
      saveContextIngestionResult(context, {
        itemId,
        expectedRevision: 0,
        attemptId: randomUUID(),
        originalHash: original.hash,
        contentHash: original.hash,
        mimeType: 'text/plain',
        byteLength: original.byteLength,
        originalStorageKey: original.storageKey,
        extractedText: 'different',
        extractionStatus: 'complete',
        uncertainty: null,
        pageCount: null,
        interpretedPages: [],
        locators: [],
        originalIsNew: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      originalStore.read(userId, original.storageKey),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('cleans a newly stored original when its version insert fails, then permits retry', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Retryable document',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const originalBytes = Buffer.from('synthetic original for retry');
    const original = await originalStore.write(userId, originalBytes, 1024);
    const extractedText = 'Retryable document text.';
    const contentHash = createHash('sha256')
      .update(extractedText)
      .digest('hex');
    const triggerName = `fail_context_version_${itemId.replaceAll('-', '')}`;
    db.$client.exec(
      `CREATE TEMP TRIGGER ${triggerName} BEFORE INSERT ON context_versions
       WHEN NEW.item_id = '${itemId}'
       BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;`,
    );
    try {
      await expect(
        saveContextIngestionResult(context, {
          itemId,
          expectedRevision: 0,
          attemptId: randomUUID(),
          originalHash: original.hash,
          contentHash,
          mimeType: 'application/pdf',
          byteLength: original.byteLength,
          originalStorageKey: original.storageKey,
          extractedText,
          extractionStatus: 'complete',
          uncertainty: null,
          pageCount: 1,
          interpretedPages: [],
          locators: [{ kind: 'page', page: 1 }],
          originalIsNew: true,
        }),
      ).rejects.toMatchObject({ code: 'storage-failed' });
    } finally {
      db.$client.exec(`DROP TRIGGER ${triggerName}`);
    }
    await expect(
      originalStore.read(userId, original.storageKey),
    ).rejects.toMatchObject({
      code: 'not-found',
    });

    const retryOriginal = await originalStore.write(
      userId,
      originalBytes,
      1024,
    );
    const savedContextItem = await saveContextIngestionResult(context, {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: retryOriginal.hash,
      contentHash,
      mimeType: 'application/pdf',
      byteLength: retryOriginal.byteLength,
      originalStorageKey: retryOriginal.storageKey,
      extractedText,
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: 1,
      interpretedPages: [],
      locators: [{ kind: 'page', page: 1 }],
      originalIsNew: true,
    });

    expect(savedContextItem).toMatchObject({
      status: 'complete',
      usable: true,
    });
    expect(await originalStore.read(userId, retryOriginal.storageKey)).toEqual(
      originalBytes,
    );
  });

  it('rejects original metadata that does not match the stored bytes', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Mismatched original',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const original = await originalStore.write(
      userId,
      Buffer.from('verified original bytes'),
      1024,
    );
    const extractedText = 'Verified extraction.';

    await expect(
      saveContextIngestionResult(context, {
        itemId,
        expectedRevision: 0,
        attemptId: randomUUID(),
        originalHash: original.hash,
        contentHash: createHash('sha256').update(extractedText).digest('hex'),
        mimeType: 'application/pdf',
        byteLength: original.byteLength + 1,
        originalStorageKey: original.storageKey,
        extractedText,
        extractionStatus: 'complete',
        uncertainty: null,
        pageCount: 1,
        interpretedPages: [],
        locators: [{ kind: 'page', page: 1 }],
        originalIsNew: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .filter((version) => version.itemId === itemId),
    ).toHaveLength(0);
    await expect(
      originalStore.read(userId, original.storageKey),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('makes ingestion retries idempotent after a committed response is lost', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Idempotent document',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const original = await originalStore.write(
      userId,
      Buffer.from('idempotent source'),
      1024,
    );
    const extractedText = 'Idempotent extraction.';
    const input = {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: original.hash,
      contentHash: createHash('sha256').update(extractedText).digest('hex'),
      mimeType: 'application/pdf',
      byteLength: original.byteLength,
      originalStorageKey: original.storageKey,
      extractedText,
      extractionStatus: 'complete' as const,
      uncertainty: null,
      pageCount: 1,
      interpretedPages: [],
      locators: [{ kind: 'page' as const, page: 1 }],
    };

    const firstResult = await saveContextIngestionResult(context, input);
    const replayedResult = await saveContextIngestionResult(context, input);

    expect(replayedResult).toEqual(firstResult);
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .filter((version) => version.itemId === itemId),
    ).toHaveLength(1);
  });

  it('does not commit ingestion after the authorizing session expires during storage reads', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'Revoked session document',
      kind: 'document',
      sessionId,
      saveToLibrary: false,
    });
    const original = await originalStore.write(
      userId,
      Buffer.from('revoked session source'),
      1024,
    );
    const extractedText = 'Revoked session extraction.';
    let authorizationChecks = 0;
    const expiringContext = {
      ...context,
      isCurrent: () => ++authorizationChecks < 2,
    };

    await expect(
      saveContextIngestionResult(expiringContext, {
        itemId,
        expectedRevision: 0,
        attemptId: randomUUID(),
        originalHash: original.hash,
        contentHash: createHash('sha256').update(extractedText).digest('hex'),
        mimeType: 'application/pdf',
        byteLength: original.byteLength,
        originalStorageKey: original.storageKey,
        extractedText,
        extractionStatus: 'complete',
        uncertainty: null,
        pageCount: 1,
        interpretedPages: [],
        locators: [{ kind: 'page', page: 1 }],
        originalIsNew: true,
      }),
    ).rejects.toMatchObject({ code: 'session-changed' });
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .filter((version) => version.itemId === itemId),
    ).toHaveLength(0);
    await expect(
      originalStore.read(userId, original.storageKey),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('does not return previews after the authorization signal is aborted', async () => {
    const note = await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Cancelled preview',
      text: 'This note should not be returned.',
      kind: 'note',
    });
    const cancelledContext = {
      ...context,
      signal: AbortSignal.abort(),
    };

    await expect(
      getContextItem(cancelledContext, { itemId: note.id }),
    ).resolves.toBeNull();
  });
});

describe('P09 ingestion against P08 storage', () => {
  it('removes a newly owned orphan after schema rejection without removing referenced bytes', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'scan.pdf',
      kind: 'document',
      saveToLibrary: true,
    });
    const bytes = Buffer.from('original');
    const original = await originalStore.write(userId, bytes);
    const valid = {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: original.hash,
      contentHash: createHash('sha256').update('saved').digest('hex'),
      mimeType: 'application/pdf',
      byteLength: bytes.length,
      originalStorageKey: original.storageKey,
      extractedText: 'saved',
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: 1,
      interpretedPages: [],
      locators: [],
      originalIsNew: true,
    };
    await saveContextIngestionResult(context, valid);
    const orphan = await originalStore.write(userId, bytes);
    await expect(
      saveContextIngestionResult(context, {
        ...valid,
        attemptId: randomUUID(),
        originalStorageKey: orphan.storageKey,
        mimeType: '',
      }),
    ).rejects.toThrow();
    expect(await originalStore.has(userId, orphan.storageKey)).toBe(false);
    await expect(
      saveContextIngestionResult(context, {
        ...valid,
        attemptId: randomUUID(),
        mimeType: '',
      }),
    ).rejects.toThrow();
    expect(await originalStore.read(userId, original.storageKey)).toEqual(
      bytes,
    );
  });

  it('fences stale revisions and foreign accounts while retaining referenced originals', async () => {
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'scan.pdf',
      kind: 'document',
      saveToLibrary: true,
    });
    const bytes = Buffer.from('retained original');
    const original = await originalStore.write(userId, bytes);
    const payload = {
      itemId,
      expectedRevision: 0,
      attemptId: randomUUID(),
      originalHash: original.hash,
      contentHash: createHash('sha256').update('saved').digest('hex'),
      mimeType: 'application/pdf',
      byteLength: bytes.length,
      originalStorageKey: original.storageKey,
      extractedText: 'saved',
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: 1,
      interpretedPages: [],
      locators: [],
      originalIsNew: true,
    };
    const saved = await saveContextIngestionResult(context, payload);
    await expect(
      saveContextIngestionResult(context, {
        ...payload,
        attemptId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    const foreign = { ...context, userId: 'other-account' };
    await expect(
      saveContextIngestionResult(foreign, {
        ...payload,
        attemptId: randomUUID(),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow();
    const stale = { ...context, isCurrent: () => false };
    await expect(
      saveContextIngestionResult(stale, {
        ...payload,
        attemptId: randomUUID(),
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow();
    expect(
      (await getContextItem(context, { itemId }))?.item.currentVersionId,
    ).toBe(saved.currentVersionId);
    expect(db.select().from(ContextVersionTable).all()).toHaveLength(1);
    expect(await originalStore.read(userId, original.storageKey)).toEqual(
      bytes,
    );
  });

  it('retries a scanned checkpoint without a current version from persisted bytes', async () => {
    const { createContextIngestionService } =
      await import('../services/ingestion');
    const bytes = Buffer.from('%PDF-1.7\nsynthetic pages');
    const itemId = randomUUID();
    await createUploadedContextItem(context, {
      itemId,
      title: 'scan.pdf',
      kind: 'document',
      saveToLibrary: true,
    });
    const writeErrors: unknown[] = [];
    let interpretedText: string | null = null;
    const readItem = async (ctx: AuthorizedContext, id: string) => {
      const detail = await getContextItem(ctx, { itemId: id });
      return detail ? { ...detail.item, removed: false } : null;
    };
    const service = createContextIngestionService({
      inspectSelectedFile: async () => ({
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        byteLength: bytes.length,
      }),
      readSelectedFile: async () => bytes,
      readItem,
      readVersion: async (ctx, id, versionId) => {
        if (!ctx.isCurrent() || ctx.signal.aborted) return null;
        const item = await readItem(ctx, id);
        if (!item) return null;
        return (
          db
            .select()
            .from(ContextVersionTable)
            .all()
            .find(
              (v) =>
                v.userId === ctx.userId &&
                v.itemId === id &&
                v.id === (versionId ?? item.currentVersionId),
            ) ?? null
        );
      },
      storeOriginal: async (ctx, input) => {
        const stored = await originalStore.write(ctx.userId, input.bytes);
        return { originalHash: stored.hash, storageKey: stored.storageKey };
      },
      readOriginal: async (ctx, id, _signal, key) => {
        if (!(await readItem(ctx, id))) return null;
        const versions = db
          .select()
          .from(ContextVersionTable)
          .all()
          .filter(
            (v) =>
              v.userId === ctx.userId &&
              v.itemId === id &&
              v.originalStorageKey &&
              (!key || v.originalStorageKey === key),
          );
        const v = versions.at(-1);
        if (!v?.originalStorageKey) return null;
        return {
          fileName: 'scan.pdf',
          contentType: v.mimeType,
          originalHash: v.originalHash,
          storageKey: v.originalStorageKey,
          bytes: await originalStore.read(
            ctx.userId,
            v.originalStorageKey,
            v.originalHash,
          ),
        };
      },
      writeAttempt: async (ctx, input) => {
        const item = await readItem(ctx, input.itemId);
        if (!item) throw Error('missing item');
        return {
          revision: (
            await setContextIngestionStatus(ctx, {
              itemId: input.itemId,
              expectedRevision: item.revision,
              status: input.status,
            })
          ).revision,
        };
      },
      updateAttemptStatus: async (ctx, input) => {
        const item = await readItem(ctx, input.itemId);
        if (!item) throw Error('missing item');
        return {
          revision: (
            await setContextIngestionStatus(ctx, {
              itemId: input.itemId,
              expectedRevision: item.revision,
              status: input.status,
            })
          ).revision,
        };
      },
      writeVersion: async (ctx, input) => {
        const { signal, operationId: _operationId, ...stored } = input;
        if (signal.aborted) throw Error('aborted');
        try {
          const item = await saveContextIngestionResult(ctx, stored);
          const version = db
            .select()
            .from(ContextVersionTable)
            .all()
            .find(
              (v) =>
                v.itemId === input.itemId && v.attemptId === input.attemptId,
            )!;
          return {
            versionId: version.id,
            revision: item.revision,
            currentVersionId: item.currentVersionId,
            usable: item.usable,
          };
        } catch (error) {
          writeErrors.push(error);
          throw error;
        }
      },
      publish: () => {},
      extractPdf: async () => ({ status: 'complete', pageCount: 1, text: '' }),
      interpretMetaPdf: async () =>
        interpretedText === null
          ? {
              status: 'unreadable',
              pages: [],
              interpretedPages: [],
              uncertainty: null,
            }
          : {
              status: 'complete',
              pages: [
                { pageNumber: 1, text: interpretedText, uncertainty: null },
              ],
              interpretedPages: [1],
              uncertainty: null,
            },
    });
    await service.ingestSelectedFile(context, { itemId, ticketId: 'ticket' });
    await service.whenIdle();
    const first = await getContextItem(context, { itemId });
    expect(writeErrors).toEqual([]);
    expect(first?.item.currentVersionId).toBeNull();
    expect(first?.versions).toHaveLength(1);
    const originalKey = db
      .select()
      .from(ContextVersionTable)
      .all()[0]!.originalStorageKey!;
    expect(await originalStore.read(userId, originalKey)).toEqual(bytes);
    interpretedText = 'Recovered from the scan';
    await service.retryContextIngestion(context, {
      itemId,
      requestId: randomUUID(),
    });
    await service.whenIdle();
    expect(writeErrors).toEqual([]);
    const recovered = await getContextItem(context, { itemId });
    expect(recovered?.item.usable).toBe(true);
    expect(recovered?.item.currentVersionId).not.toBeNull();
    interpretedText = null;
    await service.retryContextIngestion(context, {
      itemId,
      requestId: randomUUID(),
    });
    await service.whenIdle();
    expect(writeErrors).toEqual([]);
    const afterFailure = await getContextItem(context, { itemId });
    expect(afterFailure?.item.currentVersionId).toBe(
      recovered?.item.currentVersionId,
    );
    const versions = db.select().from(ContextVersionTable).all();
    expect(versions).toHaveLength(4);
    expect(versions.map((v) => v.originalStorageKey)).toEqual([
      originalKey,
      originalKey,
      originalKey,
      originalKey,
    ]);
    expect(new Set(versions.map((v) => v.attemptId)).size).toBe(4);
    expect(versions[2]?.extractedText).toContain('Recovered from the scan');
    expect(await originalStore.read(userId, originalKey)).toEqual(bytes);
  });
});
