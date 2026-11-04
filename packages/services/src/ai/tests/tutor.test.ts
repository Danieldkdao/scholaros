import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLearningDispatcher,
  learningCandidateSchema,
  learningRequestSchema,
  LearningDispatchError,
  type GeneratedPracticeCandidate,
  type PracticeEvaluateRequest,
  type PracticeGenerateRequest,
} from '../learning-dispatch';
import {
  assessPracticeCandidateForLearning,
  assessTutorCandidate,
  evaluatePracticeAnswerForLearning,
  generatePracticeCandidateForLearning,
  generateTutorCandidate,
  getLearningCapabilities,
} from '../tutor';
import {
  practiceQuestionSchema,
  type PracticeQuestionDTO,
} from '../../learning/practice-contracts';
import type { PracticeQuestionAnswerKey } from '../practice-generation';

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: {
    BETTER_AUTH_SECRET: 'x',
    META_MODEL: 'muse-spark-1.3',
    META_API_KEY: 'x' as string | undefined,
  },
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv }));

const sourceReference = {
  sourceKind: 'course-material',
  sourceId: 'material-1',
  versionId: 'version-1',
  courseId: 'course-1',
  locator: { kind: 'page', page: 2 },
  title: 'Cell structure',
  provenance: 'connected-source',
  observedAt: '2026-11-03T12:00:00Z',
  state: 'current',
} as const;
const request = {
  version: 1,
  requestId: '2d6f6b84-ef17-4b64-9f5b-22af32083d84',
  kind: 'tutor-turn',
  sessionId: 'session-1',
  courseId: 'course-1',
  contextRevision: 4,
  input: {
    activity: 'understand-topic',
    studentText: 'Explain cell membranes.',
    targetAssignmentId: null,
    sources: [
      {
        reference: sourceReference,
        text: 'The membrane regulates movement into and out of the cell.',
        score: null,
      },
    ],
    history: [],
    personalContext: { preferences: [], observations: [], revision: 0 },
    freshness: { status: 'current', lastSuccessfulAt: null },
  },
} as const;
const candidate = {
  text: 'A cell membrane controls what enters and leaves.',
  citationIndexes: [0],
  proposedEffects: [],
};
const practiceQuestion: PracticeQuestionDTO = {
  id: 'question-1',
  kind: 'multiple-choice',
  prompt: 'Which structure regulates cell transport?',
  options: [{ id: 'option-1', text: 'Cell membrane' }],
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [sourceReference],
};
const practiceAnswerKey: PracticeQuestionAnswerKey = {
  questionId: 'question-1',
  kind: 'multiple-choice',
  correctOptionId: 'option-1',
  acceptedAlternatives: [],
  explanation: 'The membrane regulates movement into and out of the cell.',
};
const practiceGenerationRequest: PracticeGenerateRequest = {
  version: 1,
  requestId: '3d6f6b84-ef17-4b64-9f5b-22af32083d84',
  kind: 'practice-generate',
  sessionId: 'session-1',
  courseId: 'course-1',
  contextRevision: 4,
  input: {
    topic: 'Cell transport',
    priorAssistanceSummary: 'One earlier practice attempt covered transport.',
    difficulty: 'developing',
    questionCount: 1,
    objectives: [{ id: 'objective-1', description: 'Explain cell transport.' }],
    sources: [
      {
        reference: sourceReference,
        excerpt: 'The membrane regulates movement into and out of the cell.',
      },
    ],
  },
};
const practiceGeneratedCandidate: GeneratedPracticeCandidate = {
  questions: [practiceQuestion],
  hostAnswerKey: [practiceAnswerKey],
  rubricVersion: 'rubric-1',
};
const practiceModelCandidate = {
  questions: [
    {
      difficulty: 'developing',
      answerability: 'answerable',
      prompt: 'Which structure regulates cell transport?',
      objectiveIndexes: [0],
      sourceIndexes: [0],
      kind: 'multiple-choice',
      options: [{ text: 'Cell membrane' }, { text: 'Nucleus' }],
      answer: {
        correctOptionIndex: 0,
        explanation:
          'The membrane regulates movement into and out of the cell.',
        acceptedAlternatives: [],
      },
    },
  ],
};
const safeIntegrityAssessment = {
  verdict: 'safe',
  riskTags: [],
  reconstructionRisk: 'none',
  sameSolutionPractice: false,
  containsHiddenAnswer: false,
  memoryPolicyBypass: false,
};
const practiceEvaluationRequest: PracticeEvaluateRequest = {
  version: 1,
  requestId: '4d6f6b84-ef17-4b64-9f5b-22af32083d84',
  kind: 'practice-evaluate',
  sessionId: 'session-1',
  courseId: 'course-1',
  contextRevision: 4,
  input: {
    question: practiceQuestion,
    answer: 'option-1',
    answerKey: practiceAnswerKey,
    rubricVersion: 'rubric-1',
    assisted: false,
  },
};
const practiceEvaluation = {
  questionId: 'question-1',
  outcome: 'correct',
  explanation: 'The membrane regulates movement into and out of the cell.',
  acceptedAlternatives: [],
  sourceReferences: [sourceReference],
  rubricVersion: 'rubric-1',
  assisted: false,
};
const capabilities = {
  version: 1,
  configurationRevision: 'configuration-1',
  tutor: 'available',
  imageInterpretation: 'available',
  pdfInterpretation: 'available',
  liveDictation: 'unavailable',
  fileDictation: 'unavailable',
  limits: {
    inputTextCharacters: 8000,
    materialWireBytes: 24 * 1024 * 1024,
    pdfPagesPerOperation: 20,
    imagesPerOperation: 4,
    dictationDurationMs: 120_000,
  },
} as const;

const metaChatResponse = (output: unknown) =>
  Response.json({
    id: 'test-completion',
    model: 'muse-spark-1.3',
    created: 1,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(output) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });

beforeEach(() => {
  delete (serverEnv as Record<string, unknown>).INFERENCE_PROVIDER;
  delete (serverEnv as Record<string, unknown>).BASETEN_API_KEY;
  delete (serverEnv as Record<string, unknown>).BASETEN_MODEL;
  Object.assign(serverEnv, {
    INFERENCE_PROVIDER: 'meta',
    META_MODEL: 'muse-spark-1.3',
    META_API_KEY: 'x',
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Meta model capability selection', () => {
  it('bounds the guard response without exhausting its reasoning token allowance', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      metaChatResponse({ allowed: true, reasonCode: 'safe' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      assessTutorCandidate(
        'synthetic-account',
        learningRequestSchema.parse(request),
        learningCandidateSchema.parse(candidate),
        [sourceReference],
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ allowed: true });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ max_completion_tokens: 2048 });
  });

  it('sends Meta-compatible structured output while retaining strict tutor and practice validation', async () => {
    const outputs: unknown[] = [candidate, practiceModelCandidate];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (String(init.body).includes('"oneOf"'))
        return Response.json(
          { error: { message: "'oneOf' is not permitted." } },
          { status: 400 },
        );
      return metaChatResponse(outputs.shift());
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateTutorCandidate(
        learningRequestSchema.parse(request),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ candidate });
    await expect(
      generatePracticeCandidateForLearning(
        practiceGenerationRequest,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ candidate: { questions: expect.any(Array) } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the host assistance summary and safe retry directive to Meta', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      metaChatResponse(candidate),
    );
    vi.stubGlobal('fetch', fetchMock);
    const priorAssistanceSummary = 'One earlier concept explanation was saved.';
    const retryRequest = learningRequestSchema.parse({
      ...request,
      input: {
        ...request.input,
        priorAssistanceSummary,
        safeRegeneration: {
          attemptNumber: 2,
          reasonCode: 'answer-risk',
        },
      },
    });

    await generateTutorCandidate(retryRequest, new AbortController().signal);

    const prompt = JSON.parse(String(fetchMock.mock.calls[0]![1].body))
      .messages[1].content;
    expect(prompt).toContain(priorAssistanceSummary);
    expect(prompt).toContain('safeRegeneration');
  });

  it('fails closed on unsupported model configuration', async () => {
    serverEnv.META_MODEL = 'muse-spark-1.3-contributor';

    expect(await getLearningCapabilities()).toMatchObject({
      tutor: 'unavailable',
      imageInterpretation: 'unavailable',
      pdfInterpretation: 'unavailable',
    });
    await expect(
      generateTutorCandidate(
        learningRequestSchema.parse(request),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
  });

  it('does not advertise an approved model when its Meta key is absent', async () => {
    serverEnv.META_API_KEY = undefined;

    expect(await getLearningCapabilities()).toMatchObject({
      tutor: 'unavailable',
      imageInterpretation: 'unavailable',
      pdfInterpretation: 'unavailable',
    });
  });

  it('uses Meta Standard when a stale provider selector points elsewhere', async () => {
    Object.assign(serverEnv, {
      INFERENCE_PROVIDER: 'baseten',
      BASETEN_API_KEY: 'legacy-test-key',
      BASETEN_MODEL: 'meta-models/muse-spark-open',
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        id: 'test-completion',
        model: 'muse-spark-1.3',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(candidate) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await getLearningCapabilities()).toMatchObject({
      tutor: 'available',
      imageInterpretation: 'available',
      pdfInterpretation: 'available',
    });
    await generateTutorCandidate(
      learningRequestSchema.parse(request),
      new AbortController().signal,
    );

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer x');
    expect(JSON.parse(String(options.body)).model).toBe('muse-spark-1.3');
  });
});

describe('Meta practice handlers', () => {
  it('rejects unsafe feedback even when the app-owned answer evaluation is deterministic', async () => {
    const fetchMock = vi.fn(async () =>
      metaChatResponse({
        ...safeIntegrityAssessment,
        verdict: 'unsafe',
        riskTags: ['answer-adjacent'],
        reconstructionRisk: 'high',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      evaluatePracticeAnswerForLearning(
        practiceEvaluationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a hidden active-work solution even when the public practice projection passes', async () => {
    const outputs: unknown[] = [
      practiceModelCandidate,
      safeIntegrityAssessment,
      { allowed: false, reasonCode: 'active-work' },
    ];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      metaChatResponse(outputs.shift()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await generatePracticeCandidateForLearning(
      practiceGenerationRequest,
      new AbortController().signal,
    );
    await expect(
      assessPracticeCandidateForLearning(
        practiceGenerationRequest,
        result.candidate,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 'retired-alternative'])(
    'generates and assesses private practice with Meta regardless of stale selector %s',
    async (selectedProvider) => {
      Object.assign(serverEnv, { INFERENCE_PROVIDER: selectedProvider });
      const outputs: unknown[] = [
        practiceModelCandidate,
        safeIntegrityAssessment,
        { allowed: true, reasonCode: 'safe' },
      ];
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
        metaChatResponse(outputs.shift()),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await generatePracticeCandidateForLearning(
        practiceGenerationRequest,
        new AbortController().signal,
      );
      await assessPracticeCandidateForLearning(
        practiceGenerationRequest,
        result.candidate,
        new AbortController().signal,
      );

      expect(result.candidate.questions).toHaveLength(1);
      expect(result.candidate.hostAnswerKey).toHaveLength(1);
      expect(JSON.stringify(result.candidate.questions)).not.toContain(
        'correctOptionId',
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        fetchMock.mock.calls.map(
          ([, options]) => JSON.parse(String(options.body)).model,
        ),
      ).toEqual(['muse-spark-1.3', 'muse-spark-1.3', 'muse-spark-1.3']);
      const integrityRequest = JSON.stringify(
        JSON.parse(String(fetchMock.mock.calls[1]![1].body)),
      );
      expect(integrityRequest).not.toContain('hostAnswerKey');
      expect(integrityRequest).not.toContain('correctOptionId');
      expect(integrityRequest).toContain(
        'Which structure regulates cell transport?',
      );
      expect(integrityRequest).toContain(
        'One earlier practice attempt covered transport.',
      );
      const privateAssessment = JSON.stringify(
        JSON.parse(String(fetchMock.mock.calls[2]![1].body)),
      );
      expect(privateAssessment).toContain('hostAnswerKey');
      expect(privateAssessment).toContain('correctOptionId');
    },
  );

  it('evaluates short explanations through the P23 evaluator on Meta Standard', async () => {
    const question: PracticeQuestionDTO = {
      ...practiceQuestion,
      kind: 'short-explanation',
      options: null,
    };
    const answerKey: PracticeQuestionAnswerKey = {
      questionId: question.id,
      kind: 'short-explanation',
      rubricCriteria: ['Identifies controlled movement'],
      acceptedAlternatives: [],
      explanation: 'The membrane regulates movement into and out of a cell.',
    };
    const evaluationInput: PracticeEvaluateRequest = {
      ...practiceEvaluationRequest,
      input: {
        ...practiceEvaluationRequest.input,
        question,
        answer: 'It regulates what enters and leaves.',
        answerKey,
      },
    };
    const outputs = [
      {
        outcome: 'correct',
        explanation: 'That identifies the membrane’s transport role.',
      },
      safeIntegrityAssessment,
    ];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      metaChatResponse(outputs.shift()),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluatePracticeAnswerForLearning(
      evaluationInput,
      new AbortController().signal,
    );

    expect(result.evaluation).toMatchObject({
      questionId: question.id,
      outcome: 'correct',
      assisted: false,
    });
    expect(result.evaluation).not.toHaveProperty('answerKey');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).model).toBe(
      'muse-spark-1.3',
    );
  });

  it('maps generation and evaluation provider failures without exposing raw errors', async () => {
    const fetchMock = vi.fn(
      async () => new Response('PRIVATE_PROVIDER_BODY', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const question: PracticeQuestionDTO = {
      ...practiceQuestion,
      kind: 'short-explanation',
      options: null,
    };
    const evaluationInput: PracticeEvaluateRequest = {
      ...practiceEvaluationRequest,
      input: {
        ...practiceEvaluationRequest.input,
        question,
        answer: 'A membrane regulates transport.',
        answerKey: {
          questionId: question.id,
          kind: 'short-explanation',
          rubricCriteria: ['Identifies controlled movement'],
          acceptedAlternatives: [],
          explanation: 'The membrane regulates cell transport.',
        },
      },
    };

    const generationError = await generatePracticeCandidateForLearning(
      practiceGenerationRequest,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    const evaluationError = await evaluatePracticeAnswerForLearning(
      evaluationInput,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(generationError).toMatchObject({ code: 'provider-failed' });
    expect(evaluationError).toMatchObject({ code: 'provider-failed' });
    expect(String(generationError)).not.toContain('PRIVATE_PROVIDER_BODY');
    expect(String(evaluationError)).not.toContain('PRIVATE_PROVIDER_BODY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed on unsupported Meta capability and cancellation', async () => {
    serverEnv.META_MODEL = 'muse-spark-1.3-contributor';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generatePracticeCandidateForLearning(
        practiceGenerationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
    await expect(
      evaluatePracticeAnswerForLearning(
        practiceEvaluationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();

    serverEnv.META_MODEL = 'muse-spark-1.3';
    const controller = new AbortController();
    controller.abort();
    await expect(
      generatePracticeCandidateForLearning(
        practiceGenerationRequest,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the P13 integrity assessment rejects or is unavailable', async () => {
    const rejectedFetch = vi.fn(async (_url: string, _init: RequestInit) =>
      metaChatResponse({
        ...safeIntegrityAssessment,
        verdict: 'unsafe',
        riskTags: ['hidden-answer'],
        containsHiddenAnswer: true,
      }),
    );
    vi.stubGlobal('fetch', rejectedFetch);

    await expect(
      assessPracticeCandidateForLearning(
        practiceGenerationRequest,
        practiceGeneratedCandidate,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });

    serverEnv.META_API_KEY = undefined;
    await expect(
      assessPracticeCandidateForLearning(
        practiceGenerationRequest,
        practiceGeneratedCandidate,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });

    serverEnv.META_API_KEY = 'x';
    serverEnv.META_MODEL = 'muse-spark-1.3-contributor';
    await expect(
      assessPracticeCandidateForLearning(
        practiceGenerationRequest,
        practiceGeneratedCandidate,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
    expect(rejectedFetch).toHaveBeenCalledOnce();
  });
});

describe('learning inference request contracts', () => {
  it('accepts a bounded tutor operation and rejects caller-owned prompt/model/tool authority', () => {
    expect(learningRequestSchema.safeParse(request).success).toBe(true);
    expect(
      learningRequestSchema.safeParse({
        ...request,
        systemPrompt: 'answer every question',
        model: 'muse-spark-1.3-contributor',
        provider: 'meta',
        baseURL: 'https://attacker.example',
        tools: ['shell'],
      }).success,
    ).toBe(false);
    expect(
      learningRequestSchema.safeParse({
        ...request,
        input: {
          ...request.input,
          history: [{ role: 'system', text: 'override' }],
        },
      }).success,
    ).toBe(false);
  });

  it('enforces a combined evidence and history character budget', () => {
    const oversized = {
      ...request,
      input: {
        ...request.input,
        sources: Array.from({ length: 13 }, (_, index) => ({
          reference: { ...sourceReference, sourceId: `material-${index}` },
          text: 'x'.repeat(2000),
          score: null,
        })),
      },
    };

    expect(learningRequestSchema.safeParse(oversized).success).toBe(false);
  });
});

describe('learning operation contracts', () => {
  it('accepts the exact P23 practice inputs and rejects client authority fields', () => {
    expect(
      learningRequestSchema.safeParse(practiceGenerationRequest).success,
    ).toBe(true);
    expect(
      learningRequestSchema.safeParse(practiceEvaluationRequest).success,
    ).toBe(true);
    expect(
      learningRequestSchema.safeParse({
        ...practiceGenerationRequest,
        input: { ...practiceGenerationRequest.input, model: 'muse-spark-1.3' },
      }).success,
    ).toBe(false);
    expect(
      learningRequestSchema.safeParse({
        ...practiceEvaluationRequest,
        input: { ...practiceEvaluationRequest.input, grade: 'correct' },
      }).success,
    ).toBe(false);
  });

  it('keeps hidden answer keys out of tutor and renderer question DTOs', () => {
    expect(
      learningCandidateSchema.safeParse({
        ...candidate,
        hostAnswerKey: practiceGeneratedCandidate.hostAnswerKey,
      }).success,
    ).toBe(false);
    expect(
      practiceQuestionSchema.safeParse({
        ...practiceQuestion,
        hostAnswerKey: practiceGeneratedCandidate.hostAnswerKey,
      }).success,
    ).toBe(false);
  });
});

describe('learning inference dispatcher', () => {
  it('returns strict practice operation responses after generation policy assessment', async () => {
    const generateOperation = vi.fn().mockResolvedValue({
      candidate: practiceGeneratedCandidate,
      usage: { inputTokens: null, outputTokens: null },
    });
    const evaluateOperation = vi.fn().mockResolvedValue({
      evaluation: practiceEvaluation,
      usage: { inputTokens: null, outputTokens: null },
    });
    const assessPracticeCandidate = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      operations: {
        'practice-generate': generateOperation,
        'practice-evaluate': evaluateOperation,
      },
      assessCandidate: vi.fn(),
      assessPracticeCandidate,
      now: () => 1_000,
    } as never);
    const signal = new AbortController().signal;

    const generationResponse = await dispatcher.dispatch(
      'account-1',
      practiceGenerationRequest,
      signal,
    );
    const evaluationResponse = await dispatcher.dispatch(
      'account-1',
      practiceEvaluationRequest,
      signal,
    );

    expect(generationResponse).toMatchObject({
      version: 1,
      requestId: practiceGenerationRequest.requestId,
      kind: 'practice-generate',
      candidate: practiceGeneratedCandidate,
      configurationRevision: 'configuration-1',
    });
    expect(evaluationResponse).toMatchObject({
      version: 1,
      requestId: practiceEvaluationRequest.requestId,
      kind: 'practice-evaluate',
      evaluation: practiceEvaluation,
      configurationRevision: 'configuration-1',
    });
    expect(assessPracticeCandidate).toHaveBeenCalledOnce();
    expect(generateOperation).toHaveBeenCalledOnce();
    expect(evaluateOperation).toHaveBeenCalledOnce();
  });

  it('fails closed when generated question and answer key assessment rejects or is unavailable', async () => {
    const operation = vi.fn().mockResolvedValue({
      candidate: practiceGeneratedCandidate,
      usage: { inputTokens: null, outputTokens: null },
    });
    const deniedDispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      operations: { 'practice-generate': operation },
      assessCandidate: vi.fn(),
      assessPracticeCandidate: vi
        .fn()
        .mockRejectedValue(new LearningDispatchError('scope-denied')),
      now: () => 1_000,
    } as never);

    await expect(
      deniedDispatcher.dispatch(
        'account-1',
        practiceGenerationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });

    const unavailableDispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      operations: { 'practice-generate': operation },
      assessCandidate: vi.fn(),
      now: () => 2_000,
    } as never);
    await expect(
      unavailableDispatcher.dispatch(
        'account-1',
        practiceGenerationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
  });

  it('does not return an evaluation after the operation is cancelled', async () => {
    const controller = new AbortController();
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      operations: {
        'practice-evaluate': vi.fn(async () => {
          controller.abort();
          return { evaluation: practiceEvaluation };
        }),
      },
      assessCandidate: vi.fn(),
      now: () => 1_000,
    } as never);

    await expect(
      dispatcher.dispatch(
        'account-1',
        practiceEvaluationRequest,
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it('fails closed when the practice evaluator is not configured', async () => {
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      assessCandidate: vi.fn(),
      now: () => 1_000,
    });

    await expect(
      dispatcher.dispatch(
        'account-1',
        practiceEvaluationRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
  });

  it('returns nothing until a candidate passes the injected policy gate', async () => {
    const order: string[] = [];
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(async () => {
        order.push('generate');
        return candidate;
      }),
      assessCandidate: vi.fn(async () => {
        order.push('assess');
        return { allowed: true, reasonCode: null };
      }),
      now: () => 1_000,
      generationId: () => 'generation-1',
    });

    const response = await dispatcher.dispatch(
      'account-1',
      request,
      new AbortController().signal,
    );

    expect(order).toEqual(['generate', 'assess']);
    expect(response).toMatchObject({
      version: 1,
      requestId: request.requestId,
      generationId: 'generation-1',
      configurationRevision: 'configuration-1',
      citations: [sourceReference],
    });
  });

  it('does not return a rejected candidate or call a client-selected model', async () => {
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn().mockResolvedValue(candidate),
      assessCandidate: vi
        .fn()
        .mockResolvedValue({ allowed: false, reasonCode: 'active-work' }),
      now: () => 1_000,
      generationId: () => 'generation-1',
    });

    await expect(
      dispatcher.dispatch('account-1', request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });

  it('rejects a citation that was not offered before policy assessment', async () => {
    const assessCandidate = vi
      .fn()
      .mockResolvedValue({ allowed: true, reasonCode: null });
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn().mockResolvedValue({
        ...candidate,
        citationIndexes: [1],
      }),
      assessCandidate,
      now: () => 1_000,
      generationId: () => 'generation-1',
    });

    await expect(
      dispatcher.dispatch('account-1', request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(assessCandidate).not.toHaveBeenCalled();
  });

  it('rejects a candidate effect from a different operation profile before assessment', async () => {
    const assessCandidate = vi
      .fn()
      .mockResolvedValue({ allowed: true, reasonCode: null });
    const activityRequest = {
      version: 1,
      requestId: '2d6f6b84-ef17-4b64-9f5b-22af32083d84',
      kind: 'activity-generate',
      sessionId: 'session-1',
      courseId: 'course-1',
      contextRevision: 4,
      input: { objective: 'Explain membrane transport.', sources: [] },
    } as const;
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      operations: {
        'activity-generate': vi.fn().mockResolvedValue({
          text: '',
          citationIndexes: [],
          proposedEffects: [
            {
              kind: 'remember-preference',
              preference: { field: 'vocabulary', value: 'simple' },
            },
          ],
        }),
      },
      assessCandidate,
      now: () => 1_000,
      generationId: () => 'generation-1',
    });

    await expect(
      dispatcher.dispatch(
        'account-1',
        activityRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(assessCandidate).not.toHaveBeenCalled();
  });

  it('discards a candidate when the model configuration changes before approval', async () => {
    const getCapabilities = vi
      .fn()
      .mockResolvedValueOnce(capabilities)
      .mockResolvedValueOnce({
        ...capabilities,
        configurationRevision: 'configuration-2',
      });
    const dispatcher = createLearningDispatcher({
      getCapabilities,
      generateCandidate: vi.fn().mockResolvedValue(candidate),
      assessCandidate: vi
        .fn()
        .mockResolvedValue({ allowed: true, reasonCode: null }),
      now: () => 1_000,
      generationId: () => 'generation-1',
    });

    await expect(
      dispatcher.dispatch('account-1', request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'capability-changed' });
  });

  it('reuses an identical request and rejects a changed payload under the same request ID', async () => {
    const generateCandidate = vi.fn().mockResolvedValue(candidate);
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate,
      assessCandidate: vi
        .fn()
        .mockResolvedValue({ allowed: true, reasonCode: null }),
      now: () => 1_000,
      generationId: () => 'generation-1',
    });
    const signal = new AbortController().signal;

    const firstResponse = await dispatcher.dispatch(
      'account-1',
      request,
      signal,
    );
    const replayedResponse = await dispatcher.dispatch(
      'account-1',
      request,
      signal,
    );

    expect(replayedResponse).toEqual(firstResponse);
    expect(generateCandidate).toHaveBeenCalledOnce();
    await expect(
      dispatcher.dispatch(
        'account-1',
        {
          ...request,
          input: { ...request.input, studentText: 'Different payload.' },
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('fails closed for an operation whose real sibling handler is unavailable', async () => {
    const dispatcher = createLearningDispatcher({
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      generateCandidate: vi.fn(),
      assessCandidate: vi.fn(),
      now: () => 1_000,
      generationId: () => 'generation-1',
    });
    const activityRequest = {
      version: 1,
      requestId: '2d6f6b84-ef17-4b64-9f5b-22af32083d84',
      kind: 'activity-generate',
      sessionId: 'session-1',
      courseId: 'course-1',
      contextRevision: 4,
      input: { objective: 'Explain membrane transport.', sources: [] },
    } as const;

    await expect(
      dispatcher.dispatch(
        'account-1',
        activityRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'feature-unavailable' });
    expect(dispatcher).toBeDefined();
  });
});
