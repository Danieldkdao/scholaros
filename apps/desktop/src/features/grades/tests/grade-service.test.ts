import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  GradeSettings,
  GradeVerificationDTO,
} from '@scholaros/services/learning/grade-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type {
  GradeObservation,
  GradeSourceRecord,
} from '../services/grade-collector';
import { createGradeService } from '../services/grade-service';
import type {
  GradeServiceStore,
  StoredGradeEvidence,
} from '../services/grade-service';

vi.mock('electron', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-grades-'));
  process.once('exit', () =>
    rmSync(userData, { recursive: true, force: true }),
  );
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
    getLoginItemSettings: () => ({ openAtLogin: false }),
  };
  const net = { fetch: vi.fn() };
  const shell = { openExternal: vi.fn() };
  return { app, net, shell, default: { app, net } };
});
vi.mock('../services/grade-collector', () => ({
  collectGradeObservation: vi.fn(),
}));

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  BrowserWorkspaceTable,
  CourseAssignmentTable,
  CourseTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  StudySessionTable,
  AssistanceLedgerTable,
  SettingTable,
} = await import('../../../db/schema');
const { gradeStore } = await import('../services/grade-store');
const { registerGradeActions } = await import('../services/grade-actions');

const accountId = 'student-a';
const courseId = 'course-a';
const assignmentId = 'assignment-a';
const sourceVersion = 'assignment-version-1';
const now = Date.parse('2026-11-03T12:00:00.000Z');
const observedAt = new Date(now).toISOString();

const context = (userId = accountId): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const source = (
  overrides: Partial<GradeSourceRecord> = {},
): GradeSourceRecord => ({
  assignmentId,
  assignmentIdentity: 'id:school-assignment-9',
  courseId,
  connectionId: 'connection-a',
  connectionHost: 'school.example',
  assignmentUrl: 'https://school.example/courses/biology/assignments/lab-1',
  assignmentTitle: 'Lab report',
  courseTitle: 'Biology',
  sourceVersion,
  eligible: true,
  suppressed: false,
  policyRevision: 0,
  ...overrides,
});

const observation = (
  overrides: Partial<GradeObservation> = {},
): GradeObservation => ({
  sourceUrl: source().assignmentUrl!,
  sourceTitle: 'Lab report',
  observedAt,
  grade: { scale: 'points', earned: 0, possible: 10 },
  completion: 'yes',
  remainingOpportunity: 'no',
  feedback: 'Check the units.',
  conflicts: [],
  contentDigest: 'digest-1',
  locators: {
    grade: { kind: 'heading', heading: 'Grade' },
    completion: { kind: 'heading', heading: 'Completion status' },
    opportunity: { kind: 'heading', heading: 'Submission availability' },
    feedback: { kind: 'heading', heading: 'Feedback' },
  },
  ...overrides,
});

const settings = (overrides: Partial<GradeSettings> = {}): GradeSettings => ({
  enabled: false,
  notes: '',
  revision: 0,
  collectedCount: 0,
  updatedAt: observedAt,
  ...overrides,
});

const storedEvidence = (
  overrides: Partial<StoredGradeEvidence> = {},
): StoredGradeEvidence => ({
  consentRevision: 1,
  assignmentVersion: sourceVersion,
  verification: {
    courseId,
    assignmentId,
    state: 'verified-completed',
    completion: 'yes',
    grade: { scale: 'points', earned: 0, possible: 10 },
    remainingOpportunity: 'no',
    feedback: null,
    observedAt,
    consentRevision: 1,
    policyRevision: 1,
    sourceReferences: [],
    reasonCode: 'verified',
  },
  ...overrides,
});

const makeStore = (initialSettings = settings(), initialSource = source()) => {
  let currentSettings = initialSettings;
  let currentSource = initialSource;
  let currentEvidence: StoredGradeEvidence | null = null;
  const store = {
    getSettings: vi.fn(() => currentSettings),
    saveSettings: vi.fn((_context, input) => {
      currentSettings = {
        ...currentSettings,
        enabled: input.enabled,
        notes: input.notes,
        revision: currentSettings.revision + 1,
        updatedAt: observedAt,
      };
      return currentSettings;
    }),
    getSource: vi.fn(() => currentSource),
    ensureProtection: vi.fn(() => 1),
    getEvidence: vi.fn(() => currentEvidence),
    saveEvidence: vi.fn((_context, input): StoredGradeEvidence | null => {
      currentEvidence = storedEvidence({
        consentRevision: input.consentRevision,
        assignmentVersion: currentSource.sourceVersion,
        verification: input.verification,
      });
      return currentEvidence;
    }),
    revokeEvidence: vi.fn(),
    deleteCollected: vi.fn(),
  } satisfies GradeServiceStore;
  return {
    store,
    setSettings: (next: GradeSettings) => (currentSettings = next),
    setSource: (next: GradeSourceRecord) => (currentSource = next),
    setEvidence: (next: StoredGradeEvidence | null) => (currentEvidence = next),
  };
};

const createCollectorMock = () =>
  vi.fn(
    async (
      _context: AuthorizedContext,
      _source: GradeSourceRecord,
      _signal: AbortSignal,
    ) => observation(),
  );

describe('grade service consent and evidence fences', () => {
  let harness: ReturnType<typeof makeStore>;
  let collect: ReturnType<typeof createCollectorMock>;
  let service: ReturnType<typeof createGradeService>;

  beforeEach(() => {
    harness = makeStore();
    collect = createCollectorMock();
    service = createGradeService({
      store: harness.store,
      collect,
      now: () => now,
    });
  });

  it('does not collect grades while the global setting is off', async () => {
    const result = await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: 'e1f5c8ec-2f39-4e36-9c70-a7a292c1b611',
    });

    expect(result.state).toBe('unknown');
    expect(result.grade).toBeNull();
    expect(result.reasonCode).toBe('grade-access-disabled');
    expect(collect).not.toHaveBeenCalled();
    expect(harness.store.saveEvidence).not.toHaveBeenCalled();
  });

  it('recognizes a zero grade only with completion and explicit closed opportunities', async () => {
    harness.setSettings(settings({ enabled: true, revision: 4 }));

    const result = await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });

    expect(result.state).toBe('verified-completed');
    expect(result.grade).toEqual({ scale: 'points', earned: 0, possible: 10 });
    expect(result.feedback).toBe('Check the units.');
    expect(harness.store.saveEvidence).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent verification for the same assignment and consent revision', async () => {
    harness.setSettings(settings({ enabled: true, revision: 4 }));
    let resolveCollection!: (value: GradeObservation) => void;
    collect.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCollection = resolve)),
    );
    const input = {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    };
    const firstVerification = service.verifyCoursework(context(), input);
    const secondVerification = service.verifyCoursework(context(), {
      ...input,
      requestId: '85edc887-8814-4f5f-a852-47f7d0ff51a4',
    });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
    resolveCollection(observation());

    const results = await Promise.all([firstVerification, secondVerification]);
    expect(results[0]).toEqual(results[1]);
    expect(harness.store.saveEvidence).toHaveBeenCalledOnce();
  });

  it('discards an observation when the assignment source changes before storage', async () => {
    harness.setSettings(settings({ enabled: true, revision: 4 }));
    harness.store.saveEvidence.mockReturnValueOnce(null);
    collect.mockImplementationOnce(async () => {
      harness.setSource(source({ sourceVersion: 'assignment-version-2' }));
      return observation();
    });

    const result = await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });

    expect(result.state).toBe('unknown');
    expect(result.reasonCode).toBe('evidence-stale');
    expect(harness.store.getSettings).toHaveBeenCalled();
  });

  it('does not persist query-bearing source URLs in grade evidence versions', async () => {
    const privateUrl = `${source().assignmentUrl}?session=fixture-only`;
    harness.setSettings(settings({ enabled: true, revision: 4 }));
    harness.setSource(source({ assignmentUrl: privateUrl }));
    collect.mockResolvedValueOnce(observation({ sourceUrl: privateUrl }));

    await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });

    const persistedVersion = JSON.parse(
      harness.store.saveEvidence.mock.calls[0]![1].sourceVersion,
    ) as Record<string, unknown>;
    expect(persistedVersion).not.toHaveProperty('sourceUrl');
    expect(JSON.stringify(persistedVersion)).not.toContain('fixture-only');
  });

  it.each([
    [
      'remaining retake',
      observation({ remainingOpportunity: 'yes' }),
      'active',
    ],
    ['reopened coursework', observation({ completion: 'no' }), 'active'],
    [
      'unknown availability',
      observation({ remainingOpportunity: 'unknown' }),
      'unknown',
    ],
    [
      'conflicting evidence',
      observation({ conflicts: ['multiple-grades'] }),
      'unknown',
    ],
    ['missing grade', observation({ grade: null }), 'unknown'],
  ] as const)('keeps %s protected', async (_name, item, state) => {
    harness.setSettings(settings({ enabled: true, revision: 1 }));
    collect.mockResolvedValueOnce(item);

    const result = await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });

    expect(result.state).toBe(state);
  });

  it('does not refetch a suppressed assignment', async () => {
    harness.setSettings(settings({ enabled: true, revision: 1 }));
    harness.setSource(source({ suppressed: true }));

    const result = await service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });

    expect(result.reasonCode).toBe('source-suppressed');
    expect(collect).not.toHaveBeenCalled();
  });

  it('discards a late page result after consent is revoked', async () => {
    harness.setSettings(settings({ enabled: true, revision: 1 }));
    let resolveCollection!: (value: GradeObservation) => void;
    collect.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCollection = resolve)),
    );
    const verification = service.verifyCoursework(context(), {
      courseId,
      assignmentId,
      requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
    });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());

    await service.saveGradeSettings(context(), {
      enabled: false,
      notes: '',
      expectedRevision: 1,
    });
    resolveCollection(observation());
    const result = await verification;

    expect(result.state).toBe('unknown');
    expect(result.grade).toBeNull();
    expect(harness.store.saveEvidence).not.toHaveBeenCalled();
    expect(harness.store.revokeEvidence).toHaveBeenCalledOnce();
  });

  it('does not revive cached completion after re-enabling consent', async () => {
    harness.setSettings(settings({ enabled: true, revision: 2 }));
    harness.setEvidence(storedEvidence({ consentRevision: 1 }));

    const result = await service.getVerifiedCourseworkEvidence(context(), {
      courseId,
      assignmentId,
    });

    expect(result?.state).toBe('unknown');
    expect(result?.grade).toBeNull();
  });

  it('rejects caller-supplied account and consent authority', async () => {
    harness.setSettings(settings({ enabled: true, revision: 1 }));

    await expect(
      service.verifyCoursework(context(), {
        courseId,
        assignmentId,
        requestId: '1d8be712-e61d-4fe8-a46d-b859da3775bf',
        userId: 'student-b',
        consent: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('awaits the settings boundary with the explicit collected-data deletion intent', async () => {
    harness.setSettings(settings({ enabled: true, revision: 1 }));
    let resolveInvalidation!: () => void;
    const invalidation = new Promise<void>((resolve) => {
      resolveInvalidation = resolve;
    });
    const onSettingsChanged = vi.fn(() => invalidation);
    const serviceWithInvalidation = createGradeService({
      store: harness.store,
      collect,
      onSettingsChanged,
    });

    let operationSettled = false;
    const operation = serviceWithInvalidation
      .saveGradeSettings(context(), {
        enabled: false,
        notes: '',
        expectedRevision: 1,
        deleteCollected: true,
      })
      .then(() => {
        operationSettled = true;
      });
    await Promise.resolve();
    expect(operationSettled).toBe(false);
    resolveInvalidation();
    await operation;

    expect(onSettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ userId: accountId }),
      expect.objectContaining({ enabled: false, revision: 2 }),
      true,
    );
    expect(harness.store.deleteCollected).toHaveBeenCalledOnce();
  });

  it('serves no cached grade while consent is off or evidence exceeds 15 minutes', async () => {
    harness.setSettings(settings({ enabled: false, revision: 2 }));
    harness.setEvidence(storedEvidence({ consentRevision: 2 }));
    const off = await service.getVerifiedCourseworkEvidence(context(), {
      courseId,
      assignmentId,
    });
    expect(off?.grade).toBeNull();

    harness.setSettings(settings({ enabled: true, revision: 2 }));
    harness.setEvidence(
      storedEvidence({
        consentRevision: 2,
        verification: {
          ...storedEvidence().verification,
          observedAt: new Date(now - 15 * 60 * 1000 - 1).toISOString(),
        },
      }),
    );
    const stale = await service.getVerifiedCourseworkEvidence(context(), {
      courseId,
      assignmentId,
    });
    expect(stale?.state).toBe('unknown');
    expect(stale?.grade).toBeNull();
  });
});

const seedPersistentGradeSource = (userId: string) => {
  const connectionId = `${userId}-connection`;
  const persistentCourseId = `${userId}-course`;
  const persistentAssignmentId = `${userId}-assignment`;
  const url = `https://school.example/courses/${userId}/assignments/lab-1`;
  db.insert(SettingTable)
    .values({ userId, consent: true, updatedAt: observedAt })
    .onConflictDoNothing()
    .run();
  db.insert(BrowserWorkspaceTable)
    .values({
      userId,
      browser: 'chrome',
      browserName: 'Chrome',
      executable: '/fixture/chrome',
      verifiedAt: observedAt,
    })
    .run();
  db.insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId,
      name: 'School LMS',
      url: 'https://school.example/',
      host: 'school.example',
      kind: 'canvas',
      status: 'verified',
      verifiedAt: observedAt,
      isCourseResource: true,
    })
    .run();
  db.insert(CourseTable)
    .values({
      id: persistentCourseId,
      userId,
      connectionId,
      sourceKey: `${userId}-course-source`,
      sourceName: 'School LMS',
      sourceHost: 'school.example',
      name: 'Biology',
      url: `https://school.example/courses/${userId}`,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    })
    .run();
  db.insert(CourseAssignmentTable)
    .values({
      id: persistentAssignmentId,
      userId,
      courseId: persistentCourseId,
      sourceKey: 'id:school-lab-1',
      title: 'Lab report',
      url,
      lastSeenAt: observedAt,
    })
    .run();
  return {
    connectionId,
    courseId: persistentCourseId,
    assignmentId: persistentAssignmentId,
    url,
  };
};

describe('grade store persistence and scope', () => {
  it('stores a zero grade, fences accounts, preserves hidden identity, and deletes only collected grades', () => {
    const userId = 'grade-store-owner';
    const otherUserId = 'grade-store-other';
    const fixture = seedPersistentGradeSource(userId);
    const ownerContext = context(userId);
    const otherContext = context(otherUserId);
    expect(
      gradeStore.getSource(
        otherContext,
        fixture.courseId,
        fixture.assignmentId,
      ),
    ).toBeNull();

    const enabled = gradeStore.saveSettings(ownerContext, {
      enabled: true,
      notes: '',
      expectedRevision: 0,
    });
    const gradeSource = gradeStore.getSource(
      ownerContext,
      fixture.courseId,
      fixture.assignmentId,
    )!;
    expect(gradeSource.eligible).toBe(true);
    const policyRevision = gradeStore.ensureProtection(
      ownerContext,
      gradeSource,
    );
    const evidenceId = 'grade-evidence-zero';
    const verification: GradeVerificationDTO = {
      courseId: fixture.courseId,
      assignmentId: fixture.assignmentId,
      state: 'verified-completed',
      completion: 'yes',
      grade: { scale: 'points', earned: 0, possible: 10 },
      remainingOpportunity: 'no',
      feedback: null,
      observedAt,
      consentRevision: enabled.revision,
      policyRevision: policyRevision + 1,
      sourceReferences: [
        {
          sourceKind: 'grade-evidence',
          sourceId: evidenceId,
          versionId: 'grade-digest-zero',
          courseId: fixture.courseId,
          locator: { kind: 'heading', heading: 'Grade' },
          title: 'Lab report',
          provenance: 'connected-source',
          observedAt,
          state: 'current',
        },
      ],
      reasonCode: 'verified',
    };
    gradeStore.saveEvidence(ownerContext, {
      source: gradeSource,
      consentRevision: enabled.revision,
      sourceVersion: JSON.stringify({
        assignmentVersion: gradeSource.sourceVersion,
        contentDigest: 'grade-digest-zero',
      }),
      verification,
    });
    const storedEvidence = gradeStore.getEvidence(ownerContext, gradeSource);
    expect(storedEvidence?.verification.grade).toEqual({
      scale: 'points',
      earned: 0,
      possible: 10,
    });
    expect(gradeStore.getSettings(userId).collectedCount).toBe(1);

    const disabled = gradeStore.saveSettings(ownerContext, {
      enabled: false,
      notes: '',
      expectedRevision: enabled.revision,
    });
    gradeStore.revokeEvidence(ownerContext, observedAt);
    expect(disabled.enabled).toBe(false);
    expect(gradeStore.getEvidence(ownerContext, gradeSource)).toBeNull();
    expect(
      gradeStore.saveEvidence(ownerContext, {
        source: gradeSource,
        consentRevision: enabled.revision,
        sourceVersion: JSON.stringify({
          assignmentVersion: gradeSource.sourceVersion,
          contentDigest: 'late-grade-digest',
        }),
        verification,
      }),
    ).toBeNull();
    expect(gradeStore.getSettings(userId).collectedCount).toBe(1);

    db.update(CourseAssignmentTable)
      .set({ suppressionId: 'hidden-group', suppressedAt: observedAt })
      .where(eq(CourseAssignmentTable.id, fixture.assignmentId))
      .run();
    const hiddenSource = gradeStore.getSource(
      ownerContext,
      fixture.courseId,
      fixture.assignmentId,
    )!;
    expect(hiddenSource.suppressed).toBe(true);
    gradeStore.ensureProtection(ownerContext, hiddenSource);
    expect(gradeStore.getEvidence(ownerContext, hiddenSource)).toBeNull();
    const retainedProtection = db
      .select()
      .from(CourseworkProtectionTable)
      .where(eq(CourseworkProtectionTable.userId, userId))
      .get();
    expect(retainedProtection?.aliases).toContain(fixture.assignmentId);
    expect(retainedProtection?.suppressed).toBe(true);
    expect(retainedProtection?.state).toBe('unknown');
    expect(gradeStore.getSettings(userId).collectedCount).toBe(1);

    gradeStore.deleteCollected(ownerContext);
    expect(gradeStore.getSettings(userId).collectedCount).toBe(0);
    expect(
      db
        .select()
        .from(CourseworkProtectionTable)
        .where(eq(CourseworkProtectionTable.userId, userId))
        .all(),
    ).toHaveLength(1);
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.id, fixture.assignmentId))
        .get()?.suppressedAt,
    ).toBe(observedAt);
  });
});

describe('grade action integration boundary', () => {
  it('passes deletion intent to the product boundary before publishing the invalidation event', async () => {
    const userId = 'grade-actions-owner';
    db.insert(SettingTable)
      .values({ userId, consent: true, updatedAt: observedAt })
      .onConflictDoNothing()
      .run();
    const handlers = new Map<
      string,
      (context: AuthorizedContext, input?: unknown) => unknown
    >();
    const sideEffects: string[] = [];
    const registrar = {
      lifecycle: {
        isCurrent: () => true,
        registerOperation: vi.fn(() => () => undefined),
        onTeardown: vi.fn(),
      },
      handle: (
        name: string,
        handler: (context: AuthorizedContext, input?: unknown) => unknown,
      ) => handlers.set(name, handler),
      publish: vi.fn(() => sideEffects.push('event')),
    } as unknown as Parameters<typeof registerGradeActions>[0];
    const cleanup = registerGradeActions(registrar, {
      onSettingsChanged: async (_context, _settings, deletedCollected) => {
        expect(deletedCollected).toBe(true);
        sideEffects.push('purge');
      },
    });
    const saveSettings = handlers.get('saveGradeSettings')!;

    await saveSettings(context(userId), {
      enabled: false,
      notes: '',
      expectedRevision: 0,
      deleteCollected: true,
    });

    expect(sideEffects).toEqual(['purge', 'event']);
    expect(gradeStore.getSettings(userId).collectedCount).toBe(0);
    expect(registrar.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: 'grades',
        targetId: null,
        revision: 1,
      }),
    );
    await cleanup();
  });
});

describe('actual grade service/store/policy composition', () => {
  it.each(['tutor-first', 'grade-first', 'legacy-alias'] as const)(
    'keeps evidence, feedback and protection history consistent for %s',
    async (order) => {
      const userId = `grade-composed-${order}`;
      const fixture = seedPersistentGradeSource(userId);
      const authorized = context(userId);
      const sessionId = randomUUID();
      const timestamp = new Date().toISOString();
      db.insert(StudySessionTable)
        .values({
          id: sessionId,
          userId,
          courseId: fixture.courseId,
          title: 'Graded review',
          activity: 'review-graded-mistakes',
          targetAssignmentId: fixture.assignmentId,
          status: 'in-progress',
          createdAt: timestamp,
          updatedAt: timestamp,
          lastOpenedAt: timestamp,
        })
        .run();
      const { resolveAssistancePolicy } =
        await import('../../integrity/services/policy');
      const { isCurrentSourceReference } =
        await import('../../integrity/services/source-preview');
      const policyInput = {
        sessionId,
        targetAssignmentId: fixture.assignmentId,
        sourceIds: [fixture.assignmentId],
      };
      let existingProtectionId: string | undefined;
      if (order !== 'grade-first') {
        const priorPolicy = resolveAssistancePolicy(authorized, policyInput);
        existingProtectionId = priorPolicy.canonicalProtectionId!;
        if (order === 'legacy-alias')
          db.update(CourseworkProtectionTable)
            .set({ canonicalIdentity: 'id:school-lab-1' })
            .where(eq(CourseworkProtectionTable.id, existingProtectionId))
            .run();
        db.insert(AssistanceLedgerTable)
          .values({
            id: randomUUID(),
            userId,
            courseId: fixture.courseId,
            protectionId: existingProtectionId,
            questionFingerprint: 'a'.repeat(64),
            assistanceUnits: 1,
            createdAt: timestamp,
            allowedSupportSummary: {
              version: 1,
              operations: {
                concept: 1,
                requirements: 0,
                'bounded-hint': 0,
                'distinct-practice': 0,
                'source-feedback-review': 0,
              },
              candidateDigests: [],
            },
          })
          .run();
      }
      const enabled = gradeStore.saveSettings(authorized, {
        enabled: true,
        notes: '',
        expectedRevision: 0,
      });
      let collected = observation({
        observedAt: timestamp,
        feedback: 'SYNTHETIC_PRIVATE_FEEDBACK',
      });
      const collect = vi.fn(async () => collected);
      const service = createGradeService({ store: gradeStore, collect });
      const evidenceInput = {
        courseId: fixture.courseId,
        assignmentId: fixture.assignmentId,
      };
      const input = { ...evidenceInput, requestId: randomUUID() };
      const verified = await service.verifyCoursework(authorized, input);
      expect(verified.state).toBe('verified-completed');
      expect(verified.feedback).toBe('SYNTHETIC_PRIVATE_FEEDBACK');
      const protections = db
        .select()
        .from(CourseworkProtectionTable)
        .where(eq(CourseworkProtectionTable.userId, userId))
        .all();
      expect(protections).toHaveLength(1);
      expect(protections[0]!.aliases).toEqual(
        expect.arrayContaining([fixture.assignmentId, 'id:school-lab-1']),
      );
      if (existingProtectionId)
        expect(protections[0]!.id).toBe(existingProtectionId);
      else
        expect(protections[0]!.canonicalIdentity).toBe(
          `assignment:${fixture.assignmentId}`,
        );
      const actualPolicy = resolveAssistancePolicy(authorized, policyInput);
      expect(actualPolicy.state).toBe('verified-completed');
      expect(actualPolicy.allowedOperations).toContain(
        'source-feedback-review',
      );
      if (existingProtectionId)
        expect(JSON.parse(actualPolicy.priorAssistanceSummary).units).toBe(1);
      const actualSession = db
        .select()
        .from(StudySessionTable)
        .where(eq(StudySessionTable.id, sessionId))
        .get()!;
      const evidence = db
        .select()
        .from(GradeEvidenceTable)
        .where(eq(GradeEvidenceTable.userId, userId))
        .get()!;
      expect(evidence.id).not.toBe(fixture.assignmentId);
      expect(
        verified.sourceReferences.some(
          ({ sourceKind }) => sourceKind === 'assignment',
        ),
      ).toBe(true);
      for (const reference of verified.sourceReferences) {
        expect(
          isCurrentSourceReference(authorized, actualSession, reference),
        ).toBe(true);
        if (reference.sourceKind === 'grade-evidence') {
          expect(reference.sourceId).toBe(evidence.id);
          expect(reference.versionId).toBe(evidence.sourceVersion);
        }
      }
      expect(JSON.stringify(evidence)).not.toContain(
        'SYNTHETIC_PRIVATE_FEEDBACK',
      );
      expect(
        (await service.getVerifiedCourseworkEvidence(authorized, evidenceInput))
          ?.feedback,
      ).toBe('SYNTHETIC_PRIVATE_FEEDBACK');
      const restarted = createGradeService({ store: gradeStore, collect });
      expect(
        (
          await restarted.getVerifiedCourseworkEvidence(
            authorized,
            evidenceInput,
          )
        )?.feedback,
      ).toBeNull();
      await restarted.dispose();
      collected = { ...collected, feedback: null };
      expect(
        (
          await service.verifyCoursework(authorized, {
            ...input,
            requestId: randomUUID(),
          })
        ).feedback,
      ).toBeNull();
      expect(
        (await service.getVerifiedCourseworkEvidence(authorized, evidenceInput))
          ?.feedback,
      ).toBeNull();
      db.update(CourseAssignmentTable)
        .set({ sourceKey: 'id:renamed-same-assignment' })
        .where(eq(CourseAssignmentTable.id, fixture.assignmentId))
        .run();
      collected = { ...collected, observedAt: new Date().toISOString() };
      expect(
        (
          await service.verifyCoursework(authorized, {
            ...input,
            requestId: randomUUID(),
          })
        ).state,
      ).toBe('verified-completed');
      expect(
        db
          .select()
          .from(CourseworkProtectionTable)
          .where(eq(CourseworkProtectionTable.userId, userId))
          .all(),
      ).toHaveLength(1);
      gradeStore.saveSettings(authorized, {
        enabled: false,
        notes: '',
        expectedRevision: enabled.revision,
      });
      expect(
        resolveAssistancePolicy(authorized, policyInput).allowedOperations,
      ).not.toContain('source-feedback-review');
      expect(
        (await service.getVerifiedCourseworkEvidence(authorized, evidenceInput))
          ?.feedback,
      ).toBeNull();
      await service.dispose();
    },
  );
});

describe('actual grade composition fail-closed cases', () => {
  it.each([
    'retake',
    'conflicting-evidence',
    'inactive',
    'suppressed',
    'ambiguous',
  ] as const)('does not unlock source feedback for %s', async (scenario) => {
    const userId = `grade-guard-${scenario}`;
    const fixture = seedPersistentGradeSource(userId);
    const authorized = context(userId);
    const timestamp = new Date().toISOString();
    const sessionId = randomUUID();
    db.insert(StudySessionTable)
      .values({
        id: sessionId,
        userId,
        courseId: fixture.courseId,
        title: 'Protected review',
        activity: 'review-graded-mistakes',
        targetAssignmentId: fixture.assignmentId,
        status: 'in-progress',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      })
      .run();
    gradeStore.saveSettings(authorized, {
      enabled: true,
      notes: '',
      expectedRevision: 0,
    });
    if (scenario === 'inactive')
      db.update(CourseAssignmentTable)
        .set({ active: false })
        .where(eq(CourseAssignmentTable.id, fixture.assignmentId))
        .run();
    if (scenario === 'suppressed')
      db.update(CourseAssignmentTable)
        .set({ suppressedAt: timestamp })
        .where(eq(CourseAssignmentTable.id, fixture.assignmentId))
        .run();
    if (scenario === 'ambiguous')
      for (const canonicalIdentity of [
        `assignment:${fixture.assignmentId}`,
        'id:school-lab-1',
      ])
        db.insert(CourseworkProtectionTable)
          .values({
            id: randomUUID(),
            userId,
            courseId: fixture.courseId,
            canonicalIdentity,
            aliases: [fixture.assignmentId, 'id:school-lab-1'],
            state: 'unknown',
          })
          .run();
    const collect = vi.fn(async () =>
      observation({
        observedAt: timestamp,
        remainingOpportunity: scenario === 'retake' ? 'yes' : 'no',
        conflicts:
          scenario === 'conflicting-evidence' ? ['conflicting-grade'] : [],
      }),
    );
    const service = createGradeService({ store: gradeStore, collect });
    const input = {
      courseId: fixture.courseId,
      assignmentId: fixture.assignmentId,
      requestId: randomUUID(),
    };
    if (scenario === 'ambiguous') {
      await expect(
        service.verifyCoursework(authorized, input),
      ).rejects.toMatchObject({ code: 'scope-denied' });
      expect(
        db
          .select()
          .from(CourseworkProtectionTable)
          .where(eq(CourseworkProtectionTable.userId, userId))
          .all(),
      ).toHaveLength(2);
    } else {
      const result = await service.verifyCoursework(authorized, input);
      expect(result.state).not.toBe('verified-completed');
      expect(result.feedback).toBeNull();
    }
    if (['inactive', 'suppressed', 'ambiguous'].includes(scenario))
      expect(collect).not.toHaveBeenCalled();
    const { resolveAssistancePolicy } =
      await import('../../integrity/services/policy');
    expect(
      resolveAssistancePolicy(authorized, {
        sessionId,
        targetAssignmentId: fixture.assignmentId,
        sourceIds: [fixture.assignmentId],
      }).allowedOperations,
    ).not.toContain('source-feedback-review');
    await service.dispose();
  });
});
