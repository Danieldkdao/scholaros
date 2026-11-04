import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLearningDispatcher,
  learningRequestSchema,
} from '../learning-dispatch';
import { generateTutorCandidate, getLearningCapabilities } from '../tutor';

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

beforeEach(() => {
  delete (serverEnv as Record<string, unknown>).INFERENCE_PROVIDER;
  delete (serverEnv as Record<string, unknown>).BASETEN_API_KEY;
  delete (serverEnv as Record<string, unknown>).BASETEN_MODEL;
  serverEnv.META_MODEL = 'muse-spark-1.3';
  serverEnv.META_API_KEY = 'x';
});
afterEach(() => vi.unstubAllGlobals());

describe('Meta model capability selection', () => {
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

describe('learning inference dispatcher', () => {
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
