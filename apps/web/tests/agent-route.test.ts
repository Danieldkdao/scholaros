import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/agent/route';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  choose: vi.fn(),
  extract: vi.fn(),
  classify: vi.fn(),
  resolve: vi.fn(),
  env: {
    BETTER_AUTH_URL: 'https://scholaros.example',
    TYPESAFE_API_KEY: 'test-typesafe' as string | undefined,
    INFERENCE_PROVIDER: 'baseten' as 'baseten' | 'meta',
    META_API_KEY: 'test-meta' as string | undefined,
    BASETEN_API_KEY: 'test-baseten' as string | undefined,
  },
}));
vi.mock('@/lib/auth/helpers', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/data/env/server', () => ({ serverEnv: mocks.env }));
vi.mock('@scholaros/env/server', () => ({ serverEnv: mocks.env }));
vi.mock('@scholaros/services/ai/academic', () => ({
  chooseAcademicTarget: mocks.choose,
  extractAcademicEvidence: mocks.extract,
}));

const body = {
  kind: 'choose',
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
const request = (value: unknown = body, origin = 'https://scholaros.example') =>
  new Request('https://scholaros.example/api/agent', {
    method: 'POST',
    headers: { origin },
    body: JSON.stringify(value),
  });
let account = 0;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request in unit test');
    }),
  );
  account += 1;
  mocks.user.mockResolvedValue({ userId: `agent-test-${account}` });
  mocks.env.INFERENCE_PROVIDER = 'baseten';
  mocks.env.META_API_KEY = 'test-meta';
  mocks.env.BASETEN_API_KEY = 'test-baseten';
  mocks.env.TYPESAFE_API_KEY = 'test-typesafe';
  mocks.choose.mockResolvedValue({ operation: 'NAVIGATE', target: '1' });
  mocks.extract.mockResolvedValue({ cards: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe('authenticated academic AI endpoint', () => {
  it('routes navigation through the shared decision service', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operation: 'NAVIGATE',
      target: '1',
    });
    expect(mocks.choose).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('routes extraction through the shared Meta service', async () => {
    const response = await POST(request({ ...body, kind: 'extract' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cards: [] });
    expect(mocks.extract).toHaveBeenCalledOnce();
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('keeps authentication and origin checks ahead of provider calls', async () => {
    expect((await POST(request(body, 'https://evil.example'))).status).toBe(
      403,
    );
    mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('rejects oversized and invalid requests before inference', async () => {
    expect(
      (await POST(request({ ...body, kind: 'arbitrary-command' }))).status,
    ).toBe(400);
    expect(
      (await POST(request({ ...body, notes: 'x'.repeat(150_001) }))).status,
    ).toBe(413);
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('preserves skippable setup errors for missing server credentials', async () => {
    mocks.env.BASETEN_API_KEY = undefined;
    expect((await POST(request())).status).toBe(503);
    expect((await POST(request({ ...body, kind: 'extract' }))).status).toBe(
      503,
    );
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('does not expose provider errors or request contents', async () => {
    mocks.choose.mockRejectedValue(new Error('private-provider-details'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-provider-details');
  });

  it('keeps the cause on the server for a failed site search', async () => {
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.resolve.mockRejectedValue(new Error('provider went quiet'));

    const response = await POST(
      request({ kind: 'resolve', prompt: 'Find my school portal' }),
    );

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('provider went quiet');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('never tells a dashboard screen about onboarding steps', async () => {
    mocks.resolve.mockRejectedValue(new Error('provider unavailable'));

    const payload = (await (
      await POST(request({ kind: 'resolve', prompt: 'Find my school portal' }))
    ).json()) as { error: string };

    expect(payload.error).not.toMatch(/step/i);
    expect(payload.error.length).toBeGreaterThan(0);
  });
});

vi.mock('@scholaros/services/ai/course-discovery', () => ({
  classifyCourseTargets: mocks.classify,
}));
it('routes semantic course recognition through the shared service', async () => {
  mocks.classify.mockResolvedValue({ courseTargetIds: ['1'] });
  const response = await POST(request({ ...body, kind: 'discover' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ courseTargetIds: ['1'] });
  expect(mocks.classify).toHaveBeenCalledOnce();
});

vi.mock('@scholaros/services/ai/connection-resolver', () => ({
  resolveConnectionRequests: mocks.resolve,
}));
it('routes a bounded connection request to the resolver', async () => {
  mocks.resolve.mockResolvedValue({ candidates: [] });
  const response = await POST(
    request({ kind: 'resolve', prompt: 'My school portal' }),
  );
  expect(response.status).toBe(200);
  expect(mocks.resolve).toHaveBeenCalledWith(
    'My school portal',
    expect.any(AbortSignal),
  );
  expect(
    (await POST(request({ kind: 'resolve', prompt: 'x'.repeat(501) }))).status,
  ).toBe(400);
});

it.each(['choose', 'extract', 'discover', 'resolve'])(
  'accepts a Meta-only configuration for %s',
  async (kind) => {
    mocks.env.INFERENCE_PROVIDER = 'meta';
    mocks.env.BASETEN_API_KEY = undefined;
    mocks.env.TYPESAFE_API_KEY = undefined;
    mocks.resolve.mockResolvedValue({ candidates: [] });
    mocks.classify.mockResolvedValue({ courseTargetIds: [] });
    const response = await POST(
      request(
        kind === 'resolve' ? { kind, prompt: 'My school' } : { ...body, kind },
      ),
    );
    expect(response.status).toBe(200);
  },
);

it.each(['choose', 'extract', 'discover', 'resolve'])(
  'rejects missing Meta credentials for %s without falling back to Baseten',
  async (kind) => {
    mocks.env.INFERENCE_PROVIDER = 'meta';
    mocks.env.META_API_KEY = undefined;
    const response = await POST(
      request(
        kind === 'resolve' ? { kind, prompt: 'My school' } : { ...body, kind },
      ),
    );
    expect(response.status).toBe(503);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  },
);
