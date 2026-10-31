import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveConnectionRequests } from '../connection-resolver';
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
afterEach(() => vi.unstubAllGlobals());
it.each(['baseten', 'meta'] as const)(
  'returns structured suggestions through %s',
  async (provider) => {
    env.INFERENCE_PROVIDER = provider;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        id: 'test',
        model: 'meta',
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                candidates: [
                  {
                    name: 'School',
                    url: 'https://school.edu',
                    provider: 'unknown',
                  },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resolveConnectionRequests(
        'My school portal',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      candidates: [
        { name: 'School', url: 'https://school.edu', provider: 'unknown' },
      ],
    });
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
    // Meta's model spends most of its budget on hidden reasoning before it emits
    // any JSON; a ceiling sized to the answer alone returns content: null.
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body)).max_tokens).toBe(4000);
  },
);

it('does not turn a failed provider request into an empty result', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json(
      { error: { message: 'Unauthorized', type: 'authentication_error' } },
      { status: 401 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    resolveConnectionRequests(
      'find some math websites',
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledOnce();
});
