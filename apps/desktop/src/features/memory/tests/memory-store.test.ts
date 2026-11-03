import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  AuthorizedRegistrar,
  InputOf,
  LearningPublicMethod,
  ProductEventV1,
  ResultOf,
} from '@scholaros/services/learning/product-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-memory-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { db } = await import('../../../db');
const { MemoryTable } = await import('../../../db/schema');
const {
  correctMemory,
  deleteMemory,
  listMemories,
  subscribeMemoryChanges,
  upsertExplicitPreference,
} = await import('../services/memory-store');
const { registerMemoryActions } = await import('../services/memory-actions');

const makeContext = (userId: string): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const requestId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  db.delete(MemoryTable).run();
});

describe('memory store', () => {
  it('limits memory reads to the authorized account and returns a real page', () => {
    const context = makeContext('memory-student');
    upsertExplicitPreference(context, {
      requestId,
      preference: { field: 'explanation-length', value: 'concise' },
    });
    upsertExplicitPreference(makeContext('other-student'), {
      requestId: '00000000-0000-4000-8000-000000000002',
      preference: { field: 'vocabulary', value: 'plain language' },
    });

    expect(listMemories(context, { limit: 1 })).toEqual({
      items: [
        expect.objectContaining({
          id: requestId,
          courseId: null,
          type: 'explicit-preference',
        }),
      ],
      nextCursor: null,
      revision: 1,
    });
  });

  it('supersedes an older inferred preference with explicit feedback', () => {
    const context = makeContext('memory-student');
    const inferredMemoryId = '00000000-0000-4000-8000-000000000003';
    db.insert(MemoryTable)
      .values({
        id: inferredMemoryId,
        userId: context.userId,
        courseId: null,
        type: 'provisional-preference',
        content: { field: 'explanation-length', value: 'concise' },
        provenance: 'meta-inferred',
        evidenceIds: ['turn-evidence'],
        confidence: 0.4,
        revision: 1,
        supersedesId: null,
        deletedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      })
      .run();

    const explicitPreference = upsertExplicitPreference(context, {
      requestId: '00000000-0000-4000-8000-000000000004',
      preference: { field: 'explanation-length', value: 'detailed' },
    });

    expect(explicitPreference).toMatchObject({
      type: 'explicit-preference',
      provenance: 'student-explicit',
      content: { field: 'explanation-length', value: 'detailed' },
      revision: 2,
    });
    expect(
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.id, explicitPreference.id))
        .get()?.supersedesId,
    ).toBe(inferredMemoryId);
    expect(
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.id, inferredMemoryId))
        .get()?.deletedAt,
    ).not.toBeNull();
  });

  it('corrects a preference with supersession and rejects a stale revision', () => {
    const context = makeContext('memory-student');
    const previousPreference = upsertExplicitPreference(context, {
      requestId,
      preference: { field: 'explanation-length', value: 'detailed' },
    });

    const correctedPreference = correctMemory(context, {
      memoryId: previousPreference.id,
      expectedRevision: previousPreference.revision,
      preference: { field: 'explanation-length', value: 'concise' },
    });

    expect(correctedPreference).toMatchObject({
      type: 'explicit-preference',
      content: { field: 'explanation-length', value: 'concise' },
      provenance: 'student-explicit',
      revision: 2,
    });
    expect(correctedPreference.id).not.toBe(previousPreference.id);
    expect(
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.id, correctedPreference.id))
        .get()?.supersedesId,
    ).toBe(previousPreference.id);
    expect(listMemories(context, { limit: 10 })?.items).toEqual([
      correctedPreference,
    ]);
    expect(() =>
      correctMemory(context, {
        memoryId: previousPreference.id,
        expectedRevision: previousPreference.revision,
        preference: { field: 'explanation-length', value: 'balanced' },
      }),
    ).toThrow('revision-conflict');
  });

  it('deletes a preference from future reads with an expected revision', () => {
    const context = makeContext('memory-student');
    const preference = upsertExplicitPreference(context, {
      requestId,
      preference: { field: 'explanation-length', value: 'concise' },
    });

    expect(
      deleteMemory(context, {
        memoryId: preference.id,
        expectedRevision: preference.revision,
      }),
    ).toEqual({ revision: 2, courseId: null });
    expect(listMemories(context, { limit: 10 })?.items).toEqual([]);
    expect(db.select().from(MemoryTable).all()[0]).toMatchObject({
      deletedAt: expect.any(String),
      content: { field: 'explanation-length', value: '' },
    });
    expect(() =>
      deleteMemory(context, {
        memoryId: preference.id,
        expectedRevision: preference.revision,
      }),
    ).toThrow('revision-conflict');
  });

  it('paginates with an opaque stable cursor without repeating entries', () => {
    const context = makeContext('memory-student');
    upsertExplicitPreference(context, {
      requestId,
      preference: { field: 'explanation-length', value: 'concise' },
    });
    upsertExplicitPreference(context, {
      requestId: '00000000-0000-4000-8000-000000000005',
      preference: { field: 'vocabulary', value: 'plain language' },
    });

    const firstPage = listMemories(context, { limit: 1 });
    const secondPage = listMemories(context, {
      limit: 1,
      cursor: firstPage?.nextCursor ?? undefined,
    });

    expect(firstPage?.items).toHaveLength(1);
    expect(firstPage?.nextCursor).toBeTruthy();
    expect(secondPage?.items).toHaveLength(1);
    expect(secondPage?.nextCursor).toBeNull();
    expect(secondPage?.items[0]?.id).not.toBe(firstPage?.items[0]?.id);
  });

  it('retries an explicit preference effect without creating another memory', () => {
    const context = makeContext('memory-student');
    const input = {
      requestId,
      preference: { field: 'explanation-length' as const, value: 'concise' },
    };

    const firstPreference = upsertExplicitPreference(context, input);
    const retriedPreference = upsertExplicitPreference(context, input);

    expect(retriedPreference).toEqual(firstPreference);
    expect(retriedPreference).toMatchObject({
      id: requestId,
      courseId: null,
      type: 'explicit-preference',
      content: input.preference,
      provenance: 'student-explicit',
      evidenceIds: [],
      confidence: null,
      revision: 1,
    });
    expect(db.select().from(MemoryTable).all()).toHaveLength(1);
  });

  it('publishes account revisions only for committed preference mutations', () => {
    const context = makeContext('memory-student');
    const changes: {
      userId: string;
      courseId: string | null;
      revision: number;
    }[] = [];
    const unsubscribe = subscribeMemoryChanges((change) =>
      changes.push(change),
    );
    try {
      const firstPreference = upsertExplicitPreference(context, {
        requestId,
        preference: { field: 'explanation-length', value: 'concise' },
      });
      const retriedPreference = upsertExplicitPreference(context, {
        requestId,
        preference: { field: 'explanation-length', value: 'concise' },
      });
      expect(retriedPreference).toEqual(firstPreference);
      const correctedPreference = correctMemory(context, {
        memoryId: firstPreference.id,
        expectedRevision: firstPreference.revision,
        preference: { field: 'explanation-length', value: 'balanced' },
      });
      deleteMemory(context, {
        memoryId: correctedPreference.id,
        expectedRevision: correctedPreference.revision,
      });
    } finally {
      unsubscribe();
    }

    expect(changes).toEqual([
      { userId: 'memory-student', courseId: null, revision: 1 },
      { userId: 'memory-student', courseId: null, revision: 2 },
      { userId: 'memory-student', courseId: null, revision: 3 },
    ]);
  });

  it('registers the typed public actions and publishes invalidation after effects commit', async () => {
    const handlers = new Map<LearningPublicMethod, unknown>();
    const events: ProductEventV1[] = [];
    const teardownCallbacks: (() => void | Promise<void>)[] = [];
    const registrar: AuthorizedRegistrar = {
      handle: (name, handler) => handlers.set(name, handler),
      publish: (event) => events.push(event),
      lifecycle: {
        signal: new AbortController().signal,
        epoch: 1,
        isCurrent: () => true,
        now: () => Date.now(),
        registerOperation: () => () => undefined,
        onTeardown: (cleanup) => teardownCallbacks.push(cleanup),
      },
    };
    const cleanup = registerMemoryActions(registrar);
    const handler = handlers.get('upsertExplicitPreference') as (
      context: AuthorizedContext,
      input: InputOf<'upsertExplicitPreference'>,
    ) => Promise<ResultOf<'upsertExplicitPreference'>>;

    expect([...handlers.keys()].sort()).toEqual([
      'correctMemory',
      'deleteMemory',
      'getLearningProgress',
      'listMemories',
      'upsertExplicitPreference',
    ]);
    const memory = await handler(makeContext('memory-student'), {
      requestId: '00000000-0000-4000-8000-000000000011',
      preference: { field: 'vocabulary', value: 'plain language' },
    });
    await cleanup();

    expect(memory).toMatchObject({
      type: 'explicit-preference',
      courseId: null,
    });
    expect(events).toEqual([
      {
        version: 1,
        accountId: 'memory-student',
        revision: 1,
        resource: 'memory',
        targetId: null,
      },
    ]);
    expect(teardownCallbacks).toHaveLength(1);
  });
});
