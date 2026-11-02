import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAcademicTarget, extractAcademicEvidence } from '../academic';

const env = vi.hoisted(() => ({
  BASETEN_API_KEY: 'test-baseten-key',
  META_API_KEY: 'test-meta-key',
  INFERENCE_PROVIDER: 'baseten' as 'baseten' | 'meta',
  BASETEN_MODEL: 'meta-models/muse-spark-open-1026',
  META_MODEL: 'muse-spark-1.3-contributor',
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv: env }));

const input = {
  kind: 'choose' as const,
  goal: 'Find my courses',
  notes: '',
  pages: [
    {
      url: 'https://school.instructure.com/',
      title: 'Courses',
      text: 'Biology',
    },
  ],
  targets: [
    {
      id: '1',
      label: 'Biology',
      url: 'https://school.instructure.com/courses/1',
    },
  ],
};
const assignment = {
  title: 'Biology',
  description: null,
  kind: 'assignment',
  state: 'active-unsubmitted',
  due: null,
  availableFrom: null,
  availableUntil: null,
  pointsPossible: null,
  url: null,
  sourceId: null,
  resources: [],
  evidence: {
    sourceUrl: input.pages[0].url,
    excerpts: ['Biology'],
    targetIds: [],
  },
};
const extracted = { assignments: [assignment], coverage: 'complete' };
const extractedMaterials = {
  materials: [
    {
      title: 'Courses',
      sourceType: 'page',
      url: input.pages[0].url,
      readability: 'readable',
      summary: null,
      summaryEvidence: [],
      evidence: {
        sourceUrl: input.pages[0].url,
        excerpts: ['Courses'],
        targetIds: [],
      },
    },
  ],
  coverage: 'complete',
};
const decisionResponse = (operation = 'NAVIGATE', target = '1') =>
  completion({ operation, target });
const completion = (value: unknown) => ({
  id: 'test-completion',
  model: env.META_MODEL,
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(value) },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sent = () => {
  const [url, options] = fetchMock.mock.calls[0];
  return {
    url,
    headers: new Headers(options?.headers),
    body: JSON.parse(String(options?.body)),
    signal: options?.signal,
  };
};

describe.each(['baseten', 'meta'] as const)(
  '%s academic AI through the real SDK',
  (provider) => {
    beforeEach(() => {
      env.INFERENCE_PROVIDER = provider;
    });
    const expectedUrl =
      provider === 'meta'
        ? 'https://api.meta.ai/v1/chat/completions'
        : 'https://inference.baseten.co/v1/chat/completions';
    const expectedKey =
      provider === 'meta' ? 'Bearer test-meta-key' : 'Bearer test-baseten-key';
    const expectedModel =
      provider === 'meta' ? env.META_MODEL : env.BASETEN_MODEL;
    it('routes bounded navigation through the selected inference provider', async () => {
      fetchMock.mockResolvedValue(Response.json(decisionResponse()));
      expect(
        await chooseAcademicTarget(input, new AbortController().signal),
      ).toEqual({ operation: 'NAVIGATE', target: '1' });
      const request = sent();
      expect(request.url).toBe(expectedUrl);
      expect(request.headers.get('authorization')).toBe(expectedKey);
      expect(request.body.model).toBe(expectedModel);
      expect(request.body.response_format.type).toBe('json_schema');
      expect(request.body.reasoning_effort).toBe('low');
    });

    it('returns DONE without sending a request when there are no targets', async () => {
      expect(
        await chooseAcademicTarget(
          { ...input, targets: [] },
          new AbortController().signal,
        ),
      ).toEqual({ operation: 'DONE', target: null });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('discards a target when the decision is DONE', async () => {
      fetchMock.mockResolvedValue(Response.json(decisionResponse('DONE')));
      expect(
        await chooseAcademicTarget(input, new AbortController().signal),
      ).toEqual({ operation: 'DONE', target: null });
    });

    it('rejects a target outside the offered choices', async () => {
      fetchMock.mockResolvedValue(
        Response.json(decisionResponse('NAVIGATE', 'unoffered')),
      );
      await expect(
        chooseAcademicTarget(input, new AbortController().signal),
      ).rejects.toThrow();
    });

    it('uses the configured Meta model with typed JSON extraction', async () => {
      fetchMock.mockResolvedValue(Response.json(completion(extracted)));
      expect(
        await extractAcademicEvidence(
          { ...input, kind: 'assignments' },
          new AbortController().signal,
        ),
      ).toEqual(extracted);
      const request = sent();
      expect(request.url).toBe(expectedUrl);
      expect(request.headers.get('authorization')).toBe(expectedKey);
      expect(request.body).toMatchObject({
        model: expectedModel,
        max_tokens: 6000,
        temperature: 0,
        response_format: { type: 'json_schema' },
      });
    });

    it('extracts course materials through the configured model and validates evidence', async () => {
      fetchMock.mockResolvedValue(
        Response.json(completion(extractedMaterials)),
      );
      expect(
        await extractAcademicEvidence(
          { ...input, kind: 'materials' },
          new AbortController().signal,
        ),
      ).toEqual(extractedMaterials);
      const request = sent();
      expect(request.url).toBe(expectedUrl);
      expect(request.body.model).toBe(expectedModel);
      expect(JSON.stringify(request.body)).toContain('summaryEvidence');
      expect(JSON.stringify(request.body)).toContain(
        'Never infer contents of unreadable or truncated materials',
      );
    });

    it('rejects malformed resource output', async () => {
      fetchMock.mockResolvedValue(
        Response.json(
          completion({
            assignments: [{ title: 'Missing fields' }],
            coverage: 'complete',
          }),
        ),
      );
      await expect(
        extractAcademicEvidence(
          { ...input, kind: 'assignments' },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    });

    it('does not retry failed provider calls', async () => {
      fetchMock.mockResolvedValue(
        Response.json({ error: 'Unavailable' }, { status: 503 }),
      );
      await expect(
        extractAcademicEvidence(
          { ...input, kind: 'assignments' },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('cancels before sending academic content', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        chooseAcademicTarget(input, controller.signal),
      ).rejects.toThrow();
      await expect(
        extractAcademicEvidence(
          { ...input, kind: 'assignments' },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  },
);

it.each(['baseten', 'meta'] as const)(
  'preserves eligibility and coverage through %s extraction',
  async (provider) => {
    env.INFERENCE_PROVIDER = provider;
    fetchMock.mockResolvedValue(Response.json(completion(extracted)));
    expect(
      await extractAcademicEvidence(
        { ...input, kind: 'assignments' },
        new AbortController().signal,
      ),
    ).toEqual(extracted);
    expect(JSON.stringify(sent().body)).toContain('active-unsubmitted');
    expect(JSON.stringify(sent().body)).toContain(
      'Keep due separate from availableUntil',
    );
  },
);
