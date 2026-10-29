import { afterEach, expect, it, vi } from 'vitest';
import { classifyCourseTargets } from '../course-discovery';

vi.mock('@scholaros/env/server', () => ({
  serverEnv: {
    BASETEN_API_KEY: 'test-key',
    META_MODEL: 'meta-models/muse-spark-open-1026',
  },
}));
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
it('classifies observed course links through Meta structured output', async () => {
  const fetchMock = vi.fn(async () => response(['1']));
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await classifyCourseTargets(input, new AbortController().signal),
  ).toEqual({ courseTargetIds: ['1'] });
  expect(fetchMock).toHaveBeenCalledOnce();
});
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
