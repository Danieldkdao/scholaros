import { describe, expect, it, vi } from 'vitest';
import type {
  AssistancePolicy,
  GradeSettings,
} from '@scholaros/services/learning/grade-contracts';
import type {
  PreparedStudyContext,
  SessionSnapshot,
} from '@scholaros/services/learning/study-contracts';
import type { AuthorizedRegistrar } from '@scholaros/services/learning/product-contracts';
import {
  createLearningClient,
  type LearningTransport,
  type TutorGenerationInput,
} from '../services/learning-client';
import {
  createTutorService,
  type TurnAdmission,
  type TutorServiceDependencies,
} from '../services/tutor';
import { registerTutorActions } from '../services/tutor-actions';
import type { StudySourceReadResult } from '../services/study-context';

const requestId = '00000000-0000-4000-8000-000000000001';
const policy: AssistancePolicy = {
  state: 'active',
  policyRevision: 2,
  consentRevision: 0,
  canonicalProtectionId: null,
  allowedOperations: ['concept', 'requirements'],
  reasonCode: 'active-coursework',
  priorAssistanceSummary: '',
};
const context: PreparedStudyContext = {
  sessionId: 'session-a',
  courseId: 'course-a',
  activity: 'understand-topic',
  topic: 'Mitochondria',
  targetAssignmentId: null,
  sourcePassages: [],
  personalContext: { preferences: [], observations: [], revision: 1 },
  history: [],
  freshness: { status: 'current', lastSuccessfulAt: null },
  contextRevision: 4,
  policy,
};
const generationInput: TutorGenerationInput = {
  requestId,
  sessionId: 'session-a',
  courseId: 'course-a',
  message: 'Explain mitochondria.',
  context,
};
const response = {
  version: 1,
  requestId,
  generationId: 'generation-a',
  parts: [{ kind: 'text' as const, text: 'Mitochondria help convert energy.' }],
  citations: [],
  proposedEffects: [],
  usage: { inputTokens: 30, outputTokens: 12 },
  configurationRevision: 'server-config-3',
};

describe('authenticated learning client', () => {
  it('uses only the fixed tutor-turn contract and returns a validated candidate', async () => {
    const requestLearning = vi.fn(async (request: unknown) => {
      expect(request).toMatchObject({
        version: 1,
        requestId,
        kind: 'tutor-turn',
        sessionId: 'session-a',
        courseId: 'course-a',
        contextRevision: 4,
      });
      expect(JSON.stringify(request)).not.toMatch(
        /model|provider|systemPrompt|apiKey/i,
      );
      return response;
    });
    const client = createLearningClient({ requestLearning });

    await expect(
      client.generateTutorCandidate(
        generationInput,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ generationId: 'generation-a' });
    expect(requestLearning).toHaveBeenCalledTimes(1);
  });

  it('preserves typed transport failures without exposing provider messages', async () => {
    const requestLearning = vi.fn(async () => {
      throw { code: 'offline', message: 'private transport detail' };
    });
    const client = createLearningClient({ requestLearning });

    await expect(
      client.generateTutorCandidate(
        generationInput,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'offline',
      message: expect.not.stringContaining('private'),
    });
  });

  it('marks malformed candidate envelopes as safe-regeneration candidates', async () => {
    const client = createLearningClient({
      requestLearning: vi.fn(async () => ({
        ...response,
        requestId: 'wrong-request',
      })),
    });

    await expect(
      client.generateTutorCandidate(
        generationInput,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      candidateInvalid: true,
    });
  });

  it('rejects cross-course context and oversized combined requests before transport', async () => {
    const requestLearning = vi.fn(async () => response);
    const client = createLearningClient({ requestLearning });

    await expect(
      client.generateTutorCandidate(
        { ...generationInput, courseId: 'course-b' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      client.generateTutorCandidate(
        { ...generationInput, sessionId: 'session-b' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    expect(requestLearning).not.toHaveBeenCalled();

    const oversizedContext = {
      ...context,
      personalContext: {
        preferences: Array.from({ length: 20 }, (_, index) => ({
          id: `preference-${index}`,
          courseId: null,
          type: 'explicit-preference' as const,
          content: { field: 'example-style' as const, value: 'x'.repeat(300) },
          provenance: 'student-explicit' as const,
          evidenceIds: Array.from({ length: 50 }, () => 'e'.repeat(300)),
          confidence: null,
          revision: 1,
          createdAt: '2026-11-03T12:00:00.000Z',
          updatedAt: '2026-11-03T12:00:00.000Z',
        })),
        observations: [],
        revision: 2,
      },
    } as PreparedStudyContext;

    await expect(
      client.generateTutorCandidate(
        { ...generationInput, context: oversizedContext },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(requestLearning).not.toHaveBeenCalled();
  });

  it('rejects a citation with an unoffered source version before returning a candidate', async () => {
    const reference = {
      sourceKind: 'course-material' as const,
      sourceId: 'material-a',
      versionId: 'version-2',
      courseId: 'course-a',
      locator: { kind: 'page' as const, page: 1 },
      title: 'Cell biology',
      provenance: 'connected-source' as const,
      observedAt: '2026-11-03T12:00:00.000Z',
      state: 'current' as const,
    };
    const staleReference = { ...reference, versionId: 'version-1' };
    const client = createLearningClient({
      requestLearning: vi.fn(async (request) => ({
        ...response,
        requestId: request.requestId,
        parts: [
          {
            kind: 'text' as const,
            text: 'This passage describes cell energy.',
          },
          { kind: 'citation' as const, reference: staleReference },
        ],
        citations: [staleReference],
      })),
    });

    await expect(
      client.generateTutorCandidate(
        {
          ...generationInput,
          context: {
            ...context,
            sourcePassages: [
              { reference, text: 'Mitochondria convert energy.', score: 1 },
            ],
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input', candidateInvalid: true });
  });
});

const tutorSessionSnapshot: SessionSnapshot = {
  session: {
    id: 'session-a',
    courseId: 'course-a',
    title: 'Mitochondria',
    activity: 'understand-topic',
    targetAssignmentId: null,
    topic: 'Mitochondria',
    status: 'in-progress',
    revision: 2,
    generationEpoch: 4,
    createdAt: '2026-11-03T12:00:00.000Z',
    updatedAt: '2026-11-03T12:00:00.000Z',
    lastOpenedAt: '2026-11-03T12:00:00.000Z',
    draft: { text: '', revision: 3 },
    timer: {
      deadlineAt: null,
      revision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
    },
  },
  messages: [],
  hasMoreBefore: false,
  activeTurn: null,
  sourceReferences: [],
  revision: 3,
};
const gradeSettings: GradeSettings = {
  enabled: false,
  notes: '',
  revision: 0,
  collectedCount: 0,
  updatedAt: '2026-11-03T12:00:00.000Z',
};
const sourceRead: StudySourceReadResult = {
  passages: [],
  status: 'current' as const,
  lastSuccessfulAt: '2026-11-03T12:00:00.000Z',
};
const lifecycle = {
  signal: new AbortController().signal,
  epoch: 5,
  isCurrent: () => true,
  now: () => Date.parse('2026-11-03T12:00:00.000Z'),
  registerOperation: () => () => undefined,
  onTeardown: () => undefined,
};

const createTurnAdmission = (input: {
  requestId: string;
  kind: 'send' | 'retry';
}): TurnAdmission => ({
  sessionId: 'session-a',
  turnId: 'turn-a',
  requestId: input.requestId,
  revision: 4,
  generationEpoch: 4,
  attemptNumber: input.kind === 'send' ? 1 : 2,
  contextRevision: 11,
  policyRevision: 2,
  gradeConsentRevision: 0,
  studentMessage: 'Explain mitochondria.',
  attachmentIds: [],
  executionRequired: true,
});

const createTutorDependencies = (
  requestLearning: LearningTransport['requestLearning'] = async (request) => ({
    ...response,
    requestId: request.requestId,
  }),
  overrides: Partial<TutorServiceDependencies> = {},
): TutorServiceDependencies => ({
  beginStudyTurn: vi.fn(async (_authorizedContext, input) =>
    createTurnAdmission(input),
  ),
  setStudyTurnStatus: vi.fn(async () => undefined),
  settleStudyTurn: vi.fn(async () => undefined),
  commitStudyTurn: vi.fn(async (_context, _input, beforePublish) => {
    beforePublish?.();
    return { committed: true, revision: 5 };
  }),
  appendStudyTurnParts: vi.fn(async () => ({ committed: true, revision: 6 })),
  assessCandidate: vi.fn<TutorServiceDependencies['assessCandidate']>(
    async () => ({
      allowed: true,
      candidateDigest: 'a'.repeat(64),
      reasonCode: 'approved',
      revision: 2,
    }),
  ),
  recordAssistance: vi.fn(() => undefined),
  reserveStudyTurnAssistance: vi.fn((_context, input, reserve) => {
    reserve();
    return input.policyRevision + 1;
  }),
  studyContext: {
    getStudySession: vi.fn(async () => tutorSessionSnapshot),
    readCourseSources: vi.fn(async () => sourceRead),
    readSelectedSources: vi.fn(async () => sourceRead),
    preparePersonalContext: vi.fn(async () => ({
      preferences: [],
      observations: [],
      revision: 1,
    })),
    readContextRevision: vi.fn(async () => 11),
    resolveAssistancePolicy: vi.fn(async () => policy),
    getGradeSettings: vi.fn(async () => gradeSettings),
  },
  learningClient: createLearningClient({ requestLearning }),
  learningEffectHandlers: {
    isTurnCurrent: vi.fn(async () => true),
    readContextRevision: vi.fn(async () => 11),
    resolveAssistancePolicy: vi.fn(async () => policy),
    getGradeSettings: vi.fn(async () => gradeSettings),
    rememberPreference: vi.fn(async () => ({
      id: 'memory-a',
      courseId: null,
      type: 'explicit-preference' as const,
      content: { field: 'explanation-length' as const, value: 'concise' },
      provenance: 'student-explicit' as const,
      evidenceIds: [],
      confidence: null,
      revision: 1,
      createdAt: '2026-11-03T12:00:00.000Z',
      updatedAt: '2026-11-03T12:00:00.000Z',
    })),
    createActivity: vi.fn(async () => ({
      artifactId: 'artifact-a',
      versionId: 'artifact-version-a',
      attemptId: 'artifact-attempt-a',
    })),
    offerPractice: vi.fn(async () => ({ practiceAttemptId: 'practice-a' })),
  },
  ...overrides,
});

const authorizedContext = () => ({
  userId: 'student-a',
  epoch: 5,
  isCurrent: () => true,
  signal: new AbortController().signal,
});
const sendInput = {
  sessionId: 'session-a',
  requestId,
  expectedDraftRevision: 3,
  text: 'Explain mitochondria.',
  attachmentIds: [],
};

describe('tutor action registration', () => {
  it('registers only the three typed tutor commands and releases its service on cleanup', async () => {
    const handle = vi.fn();
    const registrar = {
      handle,
      publish: vi.fn(),
      lifecycle,
    } as unknown as AuthorizedRegistrar;
    const dependencies = createTutorDependencies();
    const cleanup = registerTutorActions(registrar, dependencies);

    expect(handle.mock.calls.map(([name]) => name)).toEqual([
      'sendStudyTurn',
      'retryStudyTurn',
      'cancelStudyTurn',
    ]);
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

describe('durable tutor turns', () => {
  it('returns the committed draft revision without waiting for inference and preserves typed configuration failures', async () => {
    const dependencies = createTutorDependencies(async () => {
      throw {
        code: 'feature-unavailable',
        message: 'private server configuration',
      };
    });
    dependencies.beginStudyTurn = vi.fn(async (_context, input) => ({
      ...createTurnAdmission(input),
      draftRevision: 3,
    }));
    const service = createTutorService(dependencies, lifecycle);
    try {
      await expect(
        service.sendStudyTurn(authorizedContext(), sendInput),
      ).resolves.toEqual({ turnId: 'turn-a', revision: 4, draftRevision: 3 });
      await vi.waitFor(() =>
        expect(dependencies.settleStudyTurn).toHaveBeenCalledWith(
          expect.anything(),
          {
            sessionId: 'session-a',
            turnId: 'turn-a',
            status: 'failed',
            errorCode: 'feature-unavailable',
          },
        ),
      );
      expect(dependencies.commitStudyTurn).not.toHaveBeenCalled();
    } finally {
      await service.cleanup();
    }
  });

  it('deduplicates concurrent Sends for one admitted logical turn', async () => {
    let releaseCandidate:
      | ((value: Partial<typeof response>) => void)
      | undefined;
    let startedRequest: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedRequest = resolve;
    });
    const requestLearning: LearningTransport['requestLearning'] = vi.fn(
      (request) =>
        new Promise<Partial<typeof response>>((resolve) => {
          releaseCandidate = resolve;
          startedRequest?.();
        }).then((candidate) => ({
          ...response,
          ...candidate,
          requestId: request.requestId,
        })),
    );
    const dependencies = createTutorDependencies(requestLearning);
    const service = createTutorService(dependencies, lifecycle);

    const first = await service.sendStudyTurn(authorizedContext(), sendInput);
    await started;
    const duplicate = await service.sendStudyTurn(
      authorizedContext(),
      sendInput,
    );
    expect(duplicate).toEqual(first);
    expect(dependencies.beginStudyTurn).toHaveBeenCalledTimes(2);
    expect(requestLearning).toHaveBeenCalledTimes(1);

    releaseCandidate?.(response);
    await vi.waitFor(() =>
      expect(dependencies.commitStudyTurn).toHaveBeenCalledTimes(1),
    );
    expect(dependencies.setStudyTurnStatus).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ status: 'generating' }),
    );
    expect(dependencies.setStudyTurnStatus).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ status: 'checking' }),
    );
    expect(dependencies.settleStudyTurn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ turnId: 'turn-a', status: 'complete' }),
    );
    await service.cleanup();
  });

  it('retries the same logical student turn without creating another student message', async () => {
    const requestLearning = vi
      .fn<LearningTransport['requestLearning']>()
      .mockRejectedValueOnce({ code: 'offline' })
      .mockImplementation(async (request) => ({
        ...response,
        requestId: request.requestId,
      }));
    const dependencies = createTutorDependencies(requestLearning);
    const service = createTutorService(dependencies, lifecycle);
    await service.sendStudyTurn(authorizedContext(), sendInput);
    await vi.waitFor(() =>
      expect(dependencies.settleStudyTurn).toHaveBeenCalledTimes(1),
    );

    const retried = await service.retryStudyTurn(authorizedContext(), {
      sessionId: 'session-a',
      turnId: 'turn-a',
      requestId: '00000000-0000-4000-8000-000000000002',
    });

    expect(retried.turnId).toBe('turn-a');
    expect(dependencies.beginStudyTurn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ kind: 'retry', turnId: 'turn-a' }),
    );
    await vi.waitFor(() =>
      expect(dependencies.commitStudyTurn).toHaveBeenCalledTimes(1),
    );
    expect(requestLearning).toHaveBeenCalledTimes(2);
    await service.cleanup();
  });

  it('cancels only its provider request and preserves the admitted student turn', async () => {
    let startedRequest: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedRequest = resolve;
    });
    const requestLearning: LearningTransport['requestLearning'] = (
      _request,
      signal,
    ) =>
      new Promise((_resolve, reject) => {
        startedRequest?.();
        signal.addEventListener('abort', () => reject({ code: 'cancelled' }), {
          once: true,
        });
      });
    const dependencies = createTutorDependencies(requestLearning);
    const service = createTutorService(dependencies, lifecycle);
    await service.sendStudyTurn(authorizedContext(), sendInput);
    await started;

    await service.cancelStudyTurn(authorizedContext(), {
      sessionId: 'session-a',
      turnId: 'turn-a',
    });

    expect(dependencies.commitStudyTurn).not.toHaveBeenCalled();
    expect(dependencies.settleStudyTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnId: 'turn-a',
        status: 'cancelled',
        errorCode: 'cancelled',
      }),
    );
    expect(dependencies.beginStudyTurn).toHaveBeenCalledTimes(1);
    await service.cleanup();
  });

  it('fences grade-derived safe fallback parts and retains only their citations', async () => {
    const gradeReference = {
      sourceKind: 'grade-evidence' as const,
      sourceId: 'grade-a',
      versionId: 'grade-version-a',
      courseId: 'course-a',
      locator: { kind: 'page' as const, page: 1 },
      title: 'Graded feedback',
      provenance: 'connected-source' as const,
      observedAt: '2026-11-03T12:00:00.000Z',
      state: 'current' as const,
    };
    const extraGradeReference = {
      ...gradeReference,
      sourceId: 'grade-b',
      versionId: 'grade-version-b',
      locator: { kind: 'page' as const, page: 2 },
    };
    const requestLearning: LearningTransport['requestLearning'] = async (
      request,
    ) => ({
      ...response,
      requestId: request.requestId,
      citations: [gradeReference, extraGradeReference],
    });
    const defaults = createTutorDependencies();
    const dependencies = createTutorDependencies(requestLearning, {
      studyContext: {
        ...defaults.studyContext,
        readCourseSources: vi.fn(async () => ({
          passages: [
            {
              reference: gradeReference,
              text: 'Feedback about a missed concept.',
              score: 1,
            },
            {
              reference: extraGradeReference,
              text: 'Unrelated feedback.',
              score: 0.5,
            },
          ],
          status: 'current' as const,
          lastSuccessfulAt: '2026-11-03T12:00:00.000Z',
        })),
        getGradeSettings: vi.fn(async () => ({
          ...gradeSettings,
          enabled: true,
        })),
      },
      assessCandidate: vi.fn<TutorServiceDependencies['assessCandidate']>(
        async () => ({
          allowed: false,
          candidateDigest: 'b'.repeat(64),
          safeParts: [
            {
              kind: 'text' as const,
              text: 'Review the concept without repeating the answer.',
            },
            { kind: 'citation' as const, reference: gradeReference },
          ],
          reasonCode: 'answer-risk',
          revision: 2,
        }),
      ),
    });
    const service = createTutorService(dependencies, lifecycle);

    await service.sendStudyTurn(authorizedContext(), sendInput);
    await vi.waitFor(() =>
      expect(dependencies.commitStudyTurn).toHaveBeenCalledTimes(1),
    );

    expect(dependencies.commitStudyTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gradeDerived: true,
        gradeConsentRevision: gradeSettings.revision,
        sourceReferences: [gradeReference],
      }),
      undefined,
    );
    await service.cleanup();
  });

  it('does not call the provider after grade consent changes during preparation', async () => {
    let permissionRevoked = false;
    const requestLearning: LearningTransport['requestLearning'] = vi.fn(
      async (request) => ({
        ...response,
        requestId: request.requestId,
      }),
    );
    const defaults = createTutorDependencies(requestLearning);
    const dependencies = createTutorDependencies(requestLearning, {
      setStudyTurnStatus: vi.fn(async (_context, input) => {
        if (input.status === 'generating') permissionRevoked = true;
      }),
      studyContext: {
        ...defaults.studyContext,
        getGradeSettings: vi.fn(async () =>
          permissionRevoked ? { ...gradeSettings, revision: 1 } : gradeSettings,
        ),
      },
    });
    const service = createTutorService(dependencies, lifecycle);

    await service.sendStudyTurn(authorizedContext(), sendInput);
    await vi.waitFor(() =>
      expect(dependencies.settleStudyTurn).toHaveBeenCalledTimes(1),
    );

    expect(requestLearning).not.toHaveBeenCalled();
    expect(dependencies.commitStudyTurn).not.toHaveBeenCalled();
    await service.cleanup();
  });

  it('does not call the provider after the session is deleted before generation', async () => {
    let sessionDeleted = false;
    const requestLearning: LearningTransport['requestLearning'] = vi.fn(
      async (request) => ({
        ...response,
        requestId: request.requestId,
      }),
    );
    const defaults = createTutorDependencies(requestLearning);
    const dependencies = createTutorDependencies(requestLearning, {
      setStudyTurnStatus: vi.fn(async (_context, input) => {
        if (input.status === 'generating') sessionDeleted = true;
      }),
      studyContext: {
        ...defaults.studyContext,
        getStudySession: vi.fn(async () =>
          sessionDeleted ? null : tutorSessionSnapshot,
        ),
      },
    });
    const service = createTutorService(dependencies, lifecycle);

    await service.sendStudyTurn(authorizedContext(), sendInput);
    await vi.waitFor(() =>
      expect(dependencies.settleStudyTurn).toHaveBeenCalledTimes(1),
    );

    expect(requestLearning).not.toHaveBeenCalled();
    expect(dependencies.commitStudyTurn).not.toHaveBeenCalled();
    await service.cleanup();
  });

  it('records protected assistance with the captured turn and policy fence', async () => {
    const protectedPolicy = {
      ...policy,
      canonicalProtectionId: 'protection-a',
    };
    const defaults = createTutorDependencies();
    const dependencies = createTutorDependencies(undefined, {
      studyContext: {
        ...defaults.studyContext,
        resolveAssistancePolicy: vi.fn(async () => protectedPolicy),
      },
    });
    const service = createTutorService(dependencies, lifecycle);

    await service.sendStudyTurn(authorizedContext(), sendInput);
    await vi.waitFor(() =>
      expect(dependencies.recordAssistance).toHaveBeenCalledTimes(1),
    );

    expect(dependencies.recordAssistance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnId: 'turn-a',
        protectionId: 'protection-a',
        allowedSupportSummary: {
          version: 1,
          operation: 'concept',
          candidateDigest: 'a'.repeat(64),
          expectedPolicyRevision: protectedPolicy.policyRevision,
          expectedConsentRevision: protectedPolicy.consentRevision,
        },
        riskTags: [],
      }),
    );
    await service.cleanup();
  });

  it('discards a response when grade consent changes before the commit fence', async () => {
    let gradeReadCount = 0;
    const requestLearning: LearningTransport['requestLearning'] = vi.fn(
      async (request) => ({
        ...response,
        requestId: request.requestId,
      }),
    );
    const dependencies = createTutorDependencies(requestLearning);
    dependencies.studyContext.getGradeSettings = vi.fn(async () => {
      gradeReadCount += 1;
      return gradeReadCount <= 2
        ? gradeSettings
        : { ...gradeSettings, revision: 1 };
    });
    const service = createTutorService(dependencies, lifecycle);
    await service.sendStudyTurn(authorizedContext(), sendInput);

    await vi.waitFor(() =>
      expect(dependencies.settleStudyTurn).toHaveBeenCalledTimes(1),
    );
    expect(requestLearning).toHaveBeenCalledTimes(1);
    expect(dependencies.commitStudyTurn).not.toHaveBeenCalled();
    expect(dependencies.recordAssistance).not.toHaveBeenCalled();
    expect(dependencies.settleStudyTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: 'permission-revoked' }),
    );
    await service.cleanup();
  });

  it('does not resurrect a deleted session when a late candidate reaches commit', async () => {
    let deleted = false;
    const requestLearning: LearningTransport['requestLearning'] = async (
      request,
    ) => {
      deleted = true;
      return { ...response, requestId: request.requestId };
    };
    const dependencies = createTutorDependencies(requestLearning, {
      commitStudyTurn: vi.fn(async () => ({
        committed: !deleted,
        revision: 5,
      })),
    });
    const service = createTutorService(dependencies, lifecycle);
    await service.sendStudyTurn(authorizedContext(), sendInput);

    await vi.waitFor(() =>
      expect(dependencies.settleStudyTurn).toHaveBeenCalledTimes(1),
    );
    expect(dependencies.commitStudyTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.appendStudyTurnParts).not.toHaveBeenCalled();
    expect(dependencies.settleStudyTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: 'session-changed' }),
    );
    await service.cleanup();
  });
});

describe('atomic tutor effect publication', () => {
  const reference = {
    sourceKind: 'context-version' as const,
    sourceId: 'effect-source',
    versionId: 'effect-source-v1',
    courseId: 'course-a',
    locator: null,
    title: 'Synthetic study note',
    provenance: 'user-authored' as const,
    observedAt: '2026-11-03T12:00:00.000Z',
    state: 'current' as const,
  };
  const effectPolicy: AssistancePolicy = {
    ...policy,
    allowedOperations: [...policy.allowedOperations, 'distinct-practice'],
  };
  const dependenciesFor = (
    kinds: Array<'create-activity' | 'offer-practice'>,
  ) => {
    const dependencies = createTutorDependencies(async (request) => ({
      ...response,
      requestId: request.requestId,
      proposedEffects: kinds.map((kind) => ({
        kind,
        objective: 'Understand how cells convert energy.',
        references: [
          {
            sourceKind: reference.sourceKind,
            sourceId: reference.sourceId,
            versionId: reference.versionId,
            locator: null,
          },
        ],
      })),
    }));
    dependencies.studyContext.readCourseSources = vi.fn(async () => ({
      ...sourceRead,
      passages: [{ reference, text: 'Cells convert energy.', score: null }],
    }));
    dependencies.studyContext.resolveAssistancePolicy = vi.fn(
      async () => effectPolicy,
    );
    dependencies.learningEffectHandlers.resolveAssistancePolicy = vi.fn(
      async () => effectPolicy,
    );
    return dependencies;
  };
  it.each(['create-activity', 'offer-practice'] as const)(
    'commits a successful %s link in the same operation as completion',
    async (kind) => {
      const dependencies = dependenciesFor([kind]);
      const service = createTutorService(dependencies, lifecycle);
      try {
        await service.sendStudyTurn(authorizedContext(), sendInput);
        await vi.waitFor(() =>
          expect(dependencies.commitStudyTurn).toHaveBeenCalledOnce(),
        );
        const expected =
          kind === 'create-activity'
            ? {
                kind: 'activity',
                artifactId: 'artifact-a',
                versionId: 'artifact-version-a',
                attemptId: 'artifact-attempt-a',
              }
            : { kind: 'practice', practiceAttemptId: 'practice-a' };
        expect(
          vi.mocked(dependencies.commitStudyTurn).mock.calls[0]![1].parts,
        ).toContainEqual(expected);
        expect(dependencies.appendStudyTurnParts).not.toHaveBeenCalled();
      } finally {
        await service.cleanup();
      }
    },
  );
  it('commits successful links and the recoverable action failure together', async () => {
    const dependencies = dependenciesFor(['create-activity', 'offer-practice']);
    dependencies.learningEffectHandlers.offerPractice = vi.fn(async () => {
      throw new Error('Synthetic practice failure');
    });
    const service = createTutorService(dependencies, lifecycle);
    try {
      await service.sendStudyTurn(authorizedContext(), sendInput);
      await vi.waitFor(() =>
        expect(dependencies.commitStudyTurn).toHaveBeenCalledOnce(),
      );
      const parts = vi.mocked(dependencies.commitStudyTurn).mock.calls[0]![1]
        .parts;
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            artifactId: 'artifact-a',
          }),
          expect.objectContaining({
            kind: 'status',
            code: 'learning-action-unavailable',
          }),
        ]),
      );
      expect(dependencies.appendStudyTurnParts).not.toHaveBeenCalled();
    } finally {
      await service.cleanup();
    }
  });
});
