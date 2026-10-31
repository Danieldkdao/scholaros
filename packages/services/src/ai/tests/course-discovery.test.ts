import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyCourseTargets } from '../course-discovery';

const env = vi.hoisted(() => ({
  INFERENCE_PROVIDER: 'baseten' as 'baseten' | 'meta',
  BASETEN_API_KEY: 'test-baseten-key',
  META_API_KEY: 'test-meta-key',
  BASETEN_MODEL: 'test-baseten-model',
  META_MODEL: 'muse-spark-1.3-contributor',
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv: env }));
beforeEach(() => {
  env.INFERENCE_PROVIDER = 'baseten';
});
const input = {
  kind: 'discover' as const,
  goal: 'Find current courses',
  notes: '',
  pages: [
    {
      url: 'https://school.example/',
      title: 'Home',
      text: 'My classes: World History B',
    },
  ],
  targets: [
    {
      id: '1',
      label: 'World History B',
      url: 'https://school.example/section?view=9',
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());
const response = (courseTargetIds: string[]) =>
  Response.json({
    id: 'test',
    model: 'meta',
    created: 1,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({ courseTargetIds }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
it.each(['baseten', 'meta'] as const)(
  'classifies observed course links through %s',
  async (provider) => {
    env.INFERENCE_PROVIDER = provider;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      response(['1']),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await classifyCourseTargets(input, new AbortController().signal),
    ).toEqual({ courseTargetIds: ['1'] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      provider === 'meta'
        ? 'https://api.meta.ai/v1/chat/completions'
        : 'https://inference.baseten.co/v1/chat/completions',
    );
    expect(new Headers(options.headers).get('authorization')).toBe(
      provider === 'meta' ? 'Bearer test-meta-key' : 'Bearer test-baseten-key',
    );
    expect(JSON.parse(String(options.body)).model).toBe(
      provider === 'meta' ? env.META_MODEL : env.BASETEN_MODEL,
    );
  },
);
it('rejects an invented candidate id', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(['unobserved'])),
  );
  await expect(
    classifyCourseTargets(input, new AbortController().signal),
  ).rejects.toThrow();
});
it('does not call a model without observed candidates', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await classifyCourseTargets(
      { ...input, targets: [] },
      new AbortController().signal,
    ),
  ).toEqual({ courseTargetIds: [] });
  expect(fetchMock).not.toHaveBeenCalled();
});
