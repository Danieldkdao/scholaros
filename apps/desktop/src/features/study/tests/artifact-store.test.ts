import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as schema from '../../../db/schema';
import {
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import {
  createArtifactStore,
  type ArtifactStore,
} from '../services/artifact-store';

const accountId = 'user-1';
const courseId = 'course-1';
const sessionId = 'session-1';
const turnId = 'turn-1';
const timestamp = '2026-11-03T00:00:00.000Z';

const safeGraphCandidateFixture = {
  title: 'Explore a wave',
  objective: 'Predict how changing frequency changes wavelength.',
  html: '<section><label for="frequency">Frequency</label><input id="frequency" type="range" min="1" max="10" value="3"><output id="feedback" aria-live="polite">3</output><svg role="img" aria-label="Wave graph"><polyline id="wave" points="0,50 25,20 50,50 75,80 100,50"></polyline></svg></section>',
  css: 'svg { width: 100%; height: 12rem; }',
  javascript:
    "const control = document.querySelector('#frequency'); const feedback = document.querySelector('#feedback'); const wave = document.querySelector('#wave'); const draw = () => { const frequency = Number(control.value); const wavelength = 100 / frequency; const points = []; for (let x = 0; x <= 100; x += 2) points.push(x + ',' + (50 + 20 * Math.sin(2 * Math.PI * x / wavelength))); wave.setAttribute('points', points.join(' ')); feedback.textContent = `Wavelength: ${wavelength.toFixed(1)}`; }; control.addEventListener('input', draw); draw();",
  accessibleExplanation:
    'Move the frequency control and compare the live wavelength readout; higher frequency means shorter wavelength at the same wave speed.',
  sourceReferences: [],
  runtimeVersion: 1 as const,
};

const createAuthorizedContext = (isCurrent = () => true) => ({
  userId: accountId,
  epoch: 1,
  isCurrent,
  signal: new AbortController().signal,
});

let directory: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: ArtifactStore;

const seedSession = () => {
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId: accountId,
      connectionId: null,
      sourceKey: 'manual:course-1',
      sourceName: 'Manual',
      sourceHost: '',
      name: 'Physics',
      url: '',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    })
    .run();
  db.insert(StudySessionTable)
    .values({
      id: sessionId,
      userId: accountId,
      courseId,
      title: 'Wave study',
      activity: 'understand-topic',
      status: 'in-progress',
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
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    })
    .run();
  db.insert(StudyTurnTable)
    .values({
      id: turnId,
      userId: accountId,
      sessionId,
      requestId: randomUUID(),
      payloadHash: 'turn-payload-digest',
      generationEpoch: 0,
      status: 'checking',
      attemptNumber: 1,
      policyRevision: 1,
      contextRevision: 0,
      errorCode: null,
      startedAt: timestamp,
      settledAt: null,
    })
    .run();
};

const createVersion = (overrides: Record<string, unknown> = {}) =>
  store.createArtifactVersion(createAuthorizedContext(), {
    sessionId,
    turnId,
    candidate: safeGraphCandidateFixture,
    policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
    requestId: randomUUID(),
    ...overrides,
  });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scholaros-artifact-store-'));
  sqlite = new Database(join(directory, 'fixture.sqlite'));
  sqlite.pragma('foreign_keys = ON');
  db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: join(process.cwd(), 'src/db/migrations') });
  seedSession();
  store = createArtifactStore({ db });
});

afterEach(() => {
  store.dispose();
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

it('creates a new accepted immutable version and initializes host-owned state', async () => {
  const createdArtifact = await createVersion();

  expect(createdArtifact.version).toMatchObject({
    title: safeGraphCandidateFixture.title,
    objective: safeGraphCandidateFixture.objective,
    runtimeVersion: 1,
    available: true,
  });
  expect(createdArtifact.attemptId).toBeTruthy();
  const repeatedRequest = await createVersion({
    requestId: createdArtifact.version.versionId,
  });
  expect(repeatedRequest).toEqual(createdArtifact);
  await expect(
    createVersion({
      requestId: createdArtifact.version.versionId,
      turnId: 'turn-other',
    }),
  ).rejects.toMatchObject({ code: 'revision-conflict' });
  expect(
    db
      .select()
      .from(ArtifactTable)
      .where(eq(ArtifactTable.id, createdArtifact.version.artifactId))
      .get()?.currentVersionId,
  ).toBe(createdArtifact.version.versionId);
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toMatchObject({ stateRevision: 0, state: {} });
});

it('preserves the previous accepted version when regeneration is rejected', async () => {
  const firstArtifact = await createVersion();
  const invalidCandidate = {
    ...safeGraphCandidateFixture,
    javascript:
      "document.querySelector('button').addEventListener('click', () => fetch('https://example.invalid'));",
  };

  await expect(
    createVersion({
      artifactId: firstArtifact.version.artifactId,
      candidate: invalidCandidate,
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  await expect(
    createVersion({
      artifactId: firstArtifact.version.artifactId,
      candidate: { ...safeGraphCandidateFixture, title: 'Rejected by policy' },
      policyDecision: {
        allowed: false,
        reasonCode: 'active-coursework',
        revision: 1,
      },
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });

  const artifact = db
    .select()
    .from(ArtifactTable)
    .where(eq(ArtifactTable.id, firstArtifact.version.artifactId))
    .get();
  expect(artifact?.currentVersionId).toBe(firstArtifact.version.versionId);
  expect(
    db
      .select()
      .from(ArtifactVersionTable)
      .where(
        eq(ArtifactVersionTable.artifactId, firstArtifact.version.artifactId),
      )
      .all(),
  ).toHaveLength(1);
  expect(JSON.stringify(artifact)).not.toContain('example.invalid');
});

it('reopens an older immutable version offline with its exact bundle and state', async () => {
  const firstArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: firstArtifact.version.artifactId,
    versionId: firstArtifact.version.versionId,
    attemptId: firstArtifact.attemptId,
  });
  const savedState = await store.checkpointArtifactState(
    createAuthorizedContext(),
    {
      runId: run.runId,
      expectedRevision: 0,
      state: { controls: { frequency: 6 }, feedback: 'Shorter wavelength' },
    },
  );
  const nextArtifact = await createVersion({
    artifactId: firstArtifact.version.artifactId,
    candidate: {
      ...safeGraphCandidateFixture,
      title: 'Updated wave activity',
      objective: 'Compare wave speed and wavelength.',
    },
  });
  const reopenedRun = await store.authorizeActivityRun(
    createAuthorizedContext(),
    {
      sessionId,
      artifactId: firstArtifact.version.artifactId,
      versionId: firstArtifact.version.versionId,
      attemptId: firstArtifact.attemptId,
    },
  );

  expect(nextArtifact.version.versionId).not.toBe(
    firstArtifact.version.versionId,
  );
  expect(reopenedRun.bundle).toMatchObject({
    html: safeGraphCandidateFixture.html,
    css: safeGraphCandidateFixture.css,
    javascript: safeGraphCandidateFixture.javascript,
    accessibleExplanation: safeGraphCandidateFixture.accessibleExplanation,
  });
  expect(reopenedRun.contentDigest).toBe(firstArtifact.version.contentDigest);
  expect(reopenedRun.state).toEqual(savedState);
});

it('compare-and-swaps full JSON state and rejects stale revisions', async () => {
  const createdArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
  });
  const savedState = await store.checkpointArtifactState(
    createAuthorizedContext(),
    {
      runId: run.runId,
      expectedRevision: 0,
      state: { sliders: [2, 4], answer: 'wavelength decreases' },
    },
  );

  expect(savedState).toMatchObject({ stateRevision: 1 });
  await expect(
    store.checkpointArtifactState(createAuthorizedContext(), {
      runId: run.runId,
      expectedRevision: 0,
      state: { sliders: [9, 9], answer: 'stale write' },
    }),
  ).rejects.toMatchObject({ code: 'revision-conflict' });
  await expect(
    store.checkpointArtifactState(createAuthorizedContext(), {
      runId: run.runId,
      expectedRevision: 1,
      state: { constructor: { polluted: true } },
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toEqual(savedState);
});

it('rejects full-state replacements above 64 KiB without advancing the revision', async () => {
  const createdArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
  });

  await expect(
    store.checkpointArtifactState(createAuthorizedContext(), {
      runId: run.runId,
      expectedRevision: 0,
      state: { answer: 'x'.repeat(64 * 1024) },
    }),
  ).rejects.toMatchObject({ code: 'limit-exceeded' });
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toMatchObject({ stateRevision: 0, state: {} });
});

it('discards a candidate if its authorized account epoch changes during validation', async () => {
  let current = true;
  const pendingVersion = store.createArtifactVersion(
    createAuthorizedContext(() => current),
    {
      sessionId,
      turnId,
      candidate: safeGraphCandidateFixture,
      policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
      requestId: randomUUID(),
    },
  );
  current = false;

  await expect(pendingVersion).rejects.toMatchObject({
    code: 'session-changed',
  });
  expect(db.select().from(ArtifactTable).all()).toHaveLength(0);
  expect(db.select().from(ArtifactVersionTable).all()).toHaveLength(0);
});

it('releases a closed executor so late checkpoints are fenced', async () => {
  const createdArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
  });
  store.releaseActivityRun(run.runId);

  await expect(
    store.checkpointArtifactState(createAuthorizedContext(), {
      runId: run.runId,
      expectedRevision: 0,
      state: { frequency: 4 },
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toMatchObject({ stateRevision: 0, state: {} });
});

it('keeps unsupported runtime versions and prior state available for recovery', async () => {
  const createdArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
  });
  const savedState = await store.checkpointArtifactState(
    createAuthorizedContext(),
    {
      runId: run.runId,
      expectedRevision: 0,
      state: { frequency: 5 },
    },
  );
  db.update(ArtifactVersionTable)
    .set({ runtimeVersion: 2 })
    .where(eq(ArtifactVersionTable.id, createdArtifact.version.versionId))
    .run();

  expect(
    await store.getArtifactVersion(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
    }),
  ).toMatchObject({ available: false, runtimeVersion: 2 });
  await expect(
    store.authorizeActivityRun(createAuthorizedContext(), {
      sessionId,
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
  await expect(
    store.resetArtifactAttempt(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toEqual(savedState);
});

it('resets into a new attempt while retaining the previous attempt history', async () => {
  const createdArtifact = await createVersion();
  const run = await store.authorizeActivityRun(createAuthorizedContext(), {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
  });
  const previousAttempt = await store.checkpointArtifactState(
    createAuthorizedContext(),
    {
      runId: run.runId,
      expectedRevision: 0,
      state: { frequency: 7, response: 'shorter wavelength' },
    },
  );
  const nextAttempt = await store.resetArtifactAttempt(
    createAuthorizedContext(),
    {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
      requestId: randomUUID(),
    },
  );

  expect(nextAttempt.attemptId).not.toBe(createdArtifact.attemptId);
  expect(nextAttempt).toMatchObject({ stateRevision: 0, state: {} });
  expect(
    await store.getArtifactState(createAuthorizedContext(), {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    }),
  ).toEqual(previousAttempt);
  expect(
    db
      .select()
      .from(ArtifactStateTable)
      .where(
        and(
          eq(ArtifactStateTable.artifactId, createdArtifact.version.artifactId),
          eq(ArtifactStateTable.versionId, createdArtifact.version.versionId),
        ),
      )
      .all(),
  ).toHaveLength(2);
});

it('retains an independently saved Context activity after session and source removal', async () => {
  const sourceReference = {
    sourceKind: 'context-version' as const,
    sourceId: 'source-item-1',
    versionId: 'source-version-1',
    courseId,
    locator: { kind: 'page' as const, page: 2 },
    title: 'Wave relationships',
    provenance: 'user-uploaded' as const,
    observedAt: timestamp,
    state: 'current' as const,
  };
  db.insert(ContextItemTable)
    .values({
      id: sourceReference.sourceId,
      userId: accountId,
      title: sourceReference.title,
      kind: 'document',
      provenance: 'user-uploaded',
      currentVersionId: sourceReference.versionId,
      status: 'complete',
      revision: 0,
      removedAt: null,
      originatingSessionId: null,
      originatingSourceId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(ContextVersionTable)
    .values({
      id: sourceReference.versionId,
      userId: accountId,
      itemId: sourceReference.sourceId,
      attemptId: randomUUID(),
      originalHash: 'source-original-hash',
      contentHash: 'source-content-hash',
      mimeType: 'text/plain',
      byteLength: 28,
      originalStorageKey: null,
      extractedText: 'Wave speed equals frequency times wavelength.',
      extractionStatus: 'complete',
      uncertainty: null,
      pageCount: null,
      interpretedPages: [],
      locators: [],
      createdAt: timestamp,
    })
    .run();
  const createdArtifact = await createVersion({
    candidate: {
      ...safeGraphCandidateFixture,
      sourceReferences: [sourceReference],
    },
  });
  const authorizedRun = await store.authorizeActivityRun(
    createAuthorizedContext(),
    {
      sessionId,
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      attemptId: createdArtifact.attemptId,
    },
  );
  expect(authorizedRun.sourceReferences[0]).toMatchObject({
    sourceId: sourceReference.sourceId,
    state: 'historical',
  });
  const readVersion = await store.getArtifactVersion(
    createAuthorizedContext(),
    {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
    },
  );
  expect(readVersion?.sourceReferences[0]).toMatchObject({
    sourceId: sourceReference.sourceId,
    state: 'historical',
  });
  const savedItem = await store.saveArtifactToContext(
    createAuthorizedContext(),
    {
      artifactId: createdArtifact.version.artifactId,
      versionId: createdArtifact.version.versionId,
      courseId,
      requestId: randomUUID(),
    },
  );

  db.update(ContextItemTable)
    .set({ removedAt: '2026-11-03T00:01:00.000Z' })
    .where(eq(ContextItemTable.id, sourceReference.sourceId))
    .run();
  db.delete(StudySessionTable).where(eq(StudySessionTable.id, sessionId)).run();

  const storedSavedItem = db
    .select()
    .from(ContextItemTable)
    .where(eq(ContextItemTable.id, savedItem.id))
    .get();
  const storedSavedVersion = db
    .select()
    .from(ContextVersionTable)
    .where(eq(ContextVersionTable.id, savedItem.currentVersionId!))
    .get();
  const storedLink = db
    .select()
    .from(ContextLinkTable)
    .where(eq(ContextLinkTable.itemId, savedItem.id))
    .get();
  const savedPayload = JSON.parse(storedSavedVersion!.extractedText!);

  expect(storedSavedItem).toMatchObject({
    userId: accountId,
    kind: 'activity',
    provenance: 'ai-generated',
    removedAt: null,
  });
  expect(storedLink).toMatchObject({
    courseId,
    sessionId: null,
    retainedInLibrary: true,
  });
  expect(savedPayload.sourceReferences[0]).toMatchObject({
    sourceId: sourceReference.sourceId,
    versionId: sourceReference.versionId,
    state: 'historical',
  });
  expect(savedPayload.accessibleExplanation).toBe(
    safeGraphCandidateFixture.accessibleExplanation,
  );
  expect(
    await store.getArtifactVersion(
      createAuthorizedContext(() => false),
      {
        artifactId: createdArtifact.version.artifactId,
        versionId: createdArtifact.version.versionId,
      },
    ),
  ).toBeNull();
  expect(
    db
      .select()
      .from(ArtifactVersionTable)
      .where(eq(ArtifactVersionTable.id, createdArtifact.version.versionId))
      .get(),
  ).toBeDefined();
});
