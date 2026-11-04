import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../../db/schema';
import {
  CourseTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createArtifactStore } from '../../../features/study/services/artifact-store';
import { createActivityContentDigest } from '../../../features/study/services/activity-policy';
import { activityRuntimeSdkSource } from '../../../features/study/lib/activity-runtime-sdk';
import { createAcademicActivityAdapter } from '../activity-adapter';

const userId = 'user-1';
const courseId = 'course-1';
const sessionId = 'session-1';
const turnId = 'turn-1';
const timestamp = '2026-11-03T00:00:00.000Z';

const safeCandidate = {
  title: 'Explore a wave',
  objective: 'Predict how frequency changes wavelength.',
  html: '<label for="frequency">Frequency</label><input id="frequency" type="range"><output aria-live="polite"></output>',
  css: '',
  javascript:
    "const input = document.querySelector('#frequency'); const output = document.querySelector('output'); input.addEventListener('input', () => { output.textContent = input.value; });",
  accessibleExplanation:
    'Change frequency and observe the wavelength feedback.',
  sourceReferences: [],
  runtimeVersion: 1 as const,
};

const createContext = (
  overrides: { userId?: string; epoch?: number } = {},
) => ({
  userId: overrides.userId ?? userId,
  epoch: overrides.epoch ?? 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

let directory: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: ReturnType<typeof createArtifactStore>;
let adapter: ReturnType<typeof createAcademicActivityAdapter>;

const seedSession = () => {
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId,
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
      userId,
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
      userId,
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scholaros-activity-adapter-'));
  sqlite = new Database(join(directory, 'fixture.sqlite'));
  sqlite.pragma('foreign_keys = ON');
  db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: join(process.cwd(), 'src/db/migrations') });
  seedSession();
  store = createArtifactStore({ db });
  adapter = createAcademicActivityAdapter({ store });
});

afterEach(async () => {
  await adapter.dispose();
  store.dispose();
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

it('authorizes, checkpoints, fences, and releases one real P20 run', async () => {
  const context = createContext();
  const createdArtifact = await store.createArtifactVersion(context, {
    sessionId,
    turnId,
    candidate: safeCandidate,
    policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
    requestId: randomUUID(),
  });
  const request = {
    sessionId,
    artifactId: createdArtifact.version.artifactId,
    versionId: createdArtifact.version.versionId,
    attemptId: createdArtifact.attemptId,
    requestId: randomUUID(),
  };
  const authorizedRun = await adapter.authorizeActivityRun(context, request);

  expect(authorizedRun.runId).not.toBe(request.requestId);
  expect(authorizedRun.runtimeVersion).toBe('activity-runtime-v1');
  expect(authorizedRun.contentDigest).toBe(
    createdArtifact.version.contentDigest,
  );
  expect(authorizedRun.runtimeDigest).toBe(
    createActivityContentDigest({
      html: safeCandidate.html,
      css: safeCandidate.css,
      sdk: activityRuntimeSdkSource,
      javascript: safeCandidate.javascript,
    }),
  );

  const checkpointInput = {
    sessionId,
    artifactId: request.artifactId,
    versionId: request.versionId,
    attemptId: request.attemptId,
    runId: authorizedRun.runId,
    sequence: 1,
    baseStateRevision: 0,
    state: { inputs: { frequency: 5 } },
  };
  const checkpoint = await adapter.checkpointArtifactState(
    context,
    checkpointInput,
  );
  expect(checkpoint.stateRevision).toBe(1);
  expect(checkpoint.state).toEqual({ inputs: { frequency: 5 } });

  await expect(
    adapter.checkpointArtifactState(createContext({ userId: 'user-2' }), {
      ...checkpointInput,
      sequence: 2,
      baseStateRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });
  await expect(
    adapter.checkpointArtifactState(context, {
      ...checkpointInput,
      sessionId: 'session-2',
      sequence: 2,
      baseStateRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });

  const release = vi.spyOn(store, 'releaseActivityRun');
  await expect(
    adapter.releaseActivityRun({
      runId: authorizedRun.runId,
      requestId: 'different-request',
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });
  const releaseInput = {
    runId: authorizedRun.runId,
    requestId: request.requestId,
  };
  await Promise.all([
    adapter.releaseActivityRun(releaseInput),
    adapter.releaseActivityRun(releaseInput),
  ]);
  expect(release).toHaveBeenCalledTimes(1);
  await expect(
    adapter.checkpointArtifactState(context, {
      ...checkpointInput,
      sequence: 2,
      baseStateRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'scope-denied' });
});
