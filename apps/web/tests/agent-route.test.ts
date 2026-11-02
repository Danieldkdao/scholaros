import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../src/app/api/agent/route';

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
    BROWSER_NAV: 'decision' as 'decision' | 'inout' | 'invalid',
  },
  browserModel: vi.fn(),
}));
vi.mock('@/lib/auth/helpers', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/data/env/server', () => ({ serverEnv: mocks.env }));
vi.mock('@scholaros/env/server', () => ({ serverEnv: mocks.env }));
vi.mock('@scholaros/services/ai/browser-model', () => ({
  generateBrowserModel: mocks.browserModel,
}));
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
  mocks.env.BROWSER_NAV = 'decision';
  mocks.choose.mockResolvedValue({ operation: 'NAVIGATE', target: '1' });
  mocks.extract.mockResolvedValue({ assignments: [], coverage: 'complete' });
  mocks.browserModel.mockResolvedValue({
    role: 'assistant',
    content: { type: 'text', text: '{"title":"Biology"}' },
    outputFormat: 'json_schema',
    structuredContent: { title: 'Biology' },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('authenticated academic AI endpoint', () => {
  it.each(['decision', 'inout'] as const)(
    'returns the authenticated server browser mode %s without inference',
    async (mode) => {
      mocks.env.BROWSER_NAV = mode;
      const response = await GET(
        new Request('https://scholaros.example/api/agent', {
          headers: { origin: 'https://scholaros.example' },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ browserNavigationMode: mode });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(mocks.extract).not.toHaveBeenCalled();
    },
  );

  it('does not expose browser mode to another origin, signed-out requests, or invalid configuration', async () => {
    const getRequest = (origin = 'https://scholaros.example') =>
      new Request('https://scholaros.example/api/agent', {
        headers: { origin },
      });

    expect((await GET(getRequest('https://evil.example'))).status).toBe(403);
    mocks.user.mockResolvedValue(null);
    expect((await GET(getRequest())).status).toBe(401);
    mocks.user.mockResolvedValue({ userId: 'browser-mode-user' });
    mocks.env.BROWSER_NAV = 'invalid';
    expect((await GET(getRequest())).status).toBe(500);
  });

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

  it('routes bounded Stagehand requests to the server-selected model', async () => {
    const browserRequest = {
      kind: 'browser-model',
      messages: [{ role: 'user', content: 'Read the page.' }],
      responseFormat: {
        type: 'json_schema',
        name: 'extract_page',
        schema: { type: 'object', properties: {} },
      },
    };
    mocks.env.BROWSER_NAV = 'inout';
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const response = await POST(request(browserRequest));
    expect(timeout).toHaveBeenCalledWith(60_000);
    timeout.mockRestore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      await mocks.browserModel.mock.results[0]?.value,
    );
    expect(mocks.browserModel).toHaveBeenCalledOnce();
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('routes extraction through the shared Meta service', async () => {
    const response = await POST(request({ ...body, kind: 'assignments' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assignments: [],
      coverage: 'complete',
    });
    expect(mocks.extract).toHaveBeenCalledOnce();
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('stops cached browser modes after the server configuration changes', async () => {
    mocks.env.BROWSER_NAV = 'inout';
    expect(
      (await POST(request({ ...body, browserNavigationMode: 'decision' })))
        .status,
    ).toBe(409);
    expect(mocks.choose).not.toHaveBeenCalled();
    mocks.env.BROWSER_NAV = 'decision';
    expect(
      (
        await POST(
          request({
            kind: 'browser-model',
            messages: [],
            responseFormat: { type: 'text' },
          }),
        )
      ).status,
    ).toBe(409);
    expect(mocks.browserModel).not.toHaveBeenCalled();
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
    expect((await POST(request({ ...body, kind: 'assignments' }))).status).toBe(
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

  it('reports known browser protocol errors without exposing provider details', async () => {
    mocks.env.BROWSER_NAV = 'inout';
    const browserRequest = {
      kind: 'browser-model',
      messages: [
        { role: 'user', content: { type: 'text', text: 'Read page.' } },
      ],
      responseFormat: {
        type: 'json_schema',
        name: 'page',
        schema: { type: 'object', properties: {} },
      },
    };
    mocks.browserModel.mockRejectedValueOnce(
      new Error('The Stagehand browser response schema is unsupported.'),
    );
    const known = await POST(request(browserRequest));
    expect(known.status).toBe(502);
    expect(await known.json()).toEqual({
      error: 'The Stagehand browser response schema is unsupported.',
    });
    mocks.browserModel.mockRejectedValueOnce(
      new Error('private-provider-details'),
    );
    const unknown = await POST(request(browserRequest));
    expect(unknown.status).toBe(502);
    expect(await unknown.text()).not.toContain('private-provider-details');
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

it.each([
  'choose',
  'courses',
  'assignments',
  'announcements',
  'discover',
  'resolve',
])('accepts a Meta-only configuration for %s', async (kind) => {
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
});

it.each([
  'choose',
  'courses',
  'assignments',
  'announcements',
  'discover',
  'resolve',
])(
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

it('keeps deep scans running across request windows while rejecting bursts', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  try {
    for (let index = 0; index < 120; index += 1)
      expect(
        (await POST(request({ ...body, kind: 'assignments' }))).status,
      ).toBe(200);
    expect((await POST(request())).status).toBe(429);
    now.mockReturnValue(1060001);
    expect((await POST(request({ ...body, kind: 'assignments' }))).status).toBe(
      200,
    );
  } finally {
    now.mockRestore();
  }
});

it('allows bounded slow course extraction while retaining request cancellation', async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(deadline.signal);
  try {
    await POST(request({ ...body, kind: 'assignments' }));
    expect(timeout).toHaveBeenLastCalledWith(60_000);
    const extractionSignal = mocks.extract.mock.calls[0][1] as AbortSignal;
    deadline.abort();
    expect(extractionSignal.aborted).toBe(true);
    await POST(request());
    expect(timeout).toHaveBeenLastCalledWith(25_000);
  } finally {
    timeout.mockRestore();
  }
});

it('does not log academic content or provider response bodies on inference errors', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.extract.mockRejectedValueOnce(new Error('PRIVATE COURSE CONTENT'));
  await POST(request({ ...body, kind: 'assignments' }));
  expect(logged.mock.calls[0][1]).toEqual({
    kind: 'assignments',
    name: 'Error',
  });
  logged.mockRestore();
});
