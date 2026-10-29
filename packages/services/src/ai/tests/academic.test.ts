import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAcademicTarget, extractAcademicEvidence } from '../academic';

const env = vi.hoisted(() => ({
  BASETEN_API_KEY: 'test-baseten-key',
  TYPESAFE_API_KEY: 'test-typesafe-key',
  META_MODEL: 'meta-models/muse-spark-open-1026',
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
const cards = [
  {
    kind: 'course',
    title: 'Biology',
    course: null,
    detail: null,
    date: null,
    sourceUrl: input.pages[0].url,
  },
];
const decisionResponse = (operation = 'NAVIGATE', target = '1') => ({
  model: 'jev-1.14.0',
  answers: {
    operation: {
      type: 'choice',
      choice: operation,
      probabilities: {
        NAVIGATE: operation === 'NAVIGATE' ? 1 : 0,
        DONE: operation === 'DONE' ? 1 : 0,
        BLOCKED: 0,
      },
    },
    target: { type: 'choice', choice: target, probabilities: { [target]: 1 } },
  },
});
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

describe('academic AI through the real AI SDK providers', () => {
  it('uses the typed TypeSafe key and native decision questions', async () => {
    fetchMock.mockResolvedValue(Response.json(decisionResponse()));
    const controller = new AbortController();
    expect(await chooseAcademicTarget(input, controller.signal)).toEqual({
      operation: 'NAVIGATE',
      target: '1',
    });
    const request = sent();
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.get('authorization')).toBe(
      'Bearer test-typesafe-key',
    );
    expect(request.body).toMatchObject({
      model: 'jev-latest',
      state: { pages: input.pages, goal: input.goal },
      questions: {
        operation: { type: 'choice' },
        target: {
          criteria: { '1': { label: 'Biology', url: input.targets[0].url } },
        },
      },
    });
    expect(request.signal).toBeDefined();
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
    fetchMock.mockResolvedValue(Response.json(completion({ cards })));
    expect(
      await extractAcademicEvidence(
        { ...input, kind: 'extract' },
        new AbortController().signal,
      ),
    ).toEqual({ cards });
    const request = sent();
    expect(request.url).toBe(
      'https://inference.baseten.co/v1/chat/completions',
    );
    expect(request.headers.get('authorization')).toBe(
      'Bearer test-baseten-key',
    );
    expect(request.body).toMatchObject({
      model: env.META_MODEL,
      max_tokens: 2400,
      temperature: 0,
      response_format: { type: 'json_schema' },
    });
  });

  it('rejects malformed evidence and source URLs not in the supplied pages', async () => {
    for (const value of [
      { cards: [{ title: 'Missing fields' }] },
      {
        cards: [
          { ...cards[0], sourceUrl: 'https://unconnected.example/course' },
        ],
      },
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json(completion(value)));
      await expect(
        extractAcademicEvidence(
          { ...input, kind: 'extract' },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });

  it('does not retry failed provider calls', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Unavailable' }, { status: 503 }),
    );
    await expect(
      extractAcademicEvidence(
        { ...input, kind: 'extract' },
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
      extractAcademicEvidence({ ...input, kind: 'extract' }, controller.signal),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
