import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isSessionCurrent: vi.fn(),
  getCookie: vi.fn(),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.request,
  isAccountSessionCurrent: mocks.isSessionCurrent,
}));
vi.mock('../../../lib/auth/client', () => ({
  authClient: { getCookie: mocks.getCookie },
}));

const {
  BrowserCapabilityChangedError,
  getBrowserNavigationMode,
  invalidateBrowserNavigationMode,
  toBrowserCapabilityError,
} = await import('../services/browser-mode');

beforeEach(() => {
  vi.clearAllMocks();
  invalidateBrowserNavigationMode();
  mocks.getCookie.mockReturnValue('student-session-a');
  mocks.isSessionCurrent.mockReturnValue(true);
  mocks.request.mockResolvedValue({ browserNavigationMode: 'decision' });
});

describe('server-selected browser navigation mode', () => {
  it('reads one authenticated capability and caches it for the current session', async () => {
    const options = {
      signal: new AbortController().signal,
      isCurrent: () => true,
    };

    await expect(getBrowserNavigationMode(options)).resolves.toBe('decision');
    await expect(getBrowserNavigationMode(options)).resolves.toBe('decision');

    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/agent',
      undefined,
      options.signal,
    );
  });

  it('accepts the agent response envelope with additive model capability metadata', async () => {
    mocks.request.mockResolvedValueOnce({
      browserNavigationMode: 'decision',
      modelCapabilities: {
        version: 1,
        configurationRevision: 'v1-model-configuration',
        endpointCategory: 'meta-standard',
        operations: { 'decision-navigation': true },
      },
    });

    await expect(
      getBrowserNavigationMode({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).resolves.toBe('decision');
  });

  it.each([
    { browserNavigationMode: 'fallback', modelCapabilities: {} },
    { modelCapabilities: {} },
    { browserNavigationMode: null, modelCapabilities: {} },
    null,
    [],
  ])(
    'still rejects malformed browser modes in an agent envelope %j',
    async (response) => {
      mocks.request.mockResolvedValueOnce(response);
      await expect(
        getBrowserNavigationMode({
          signal: new AbortController().signal,
          isCurrent: () => true,
        }),
      ).rejects.toThrow(/browser mode/i);
      mocks.request.mockResolvedValueOnce({ browserNavigationMode: 'inout' });
      await expect(
        getBrowserNavigationMode({
          signal: new AbortController().signal,
          isCurrent: () => true,
        }),
      ).resolves.toBe('inout');
    },
  );

  it('reloads the capability after the authenticated session changes', async () => {
    const options = {
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    await getBrowserNavigationMode(options);
    mocks.getCookie.mockReturnValue('student-session-b');
    mocks.request.mockResolvedValueOnce({ browserNavigationMode: 'inout' });

    await expect(getBrowserNavigationMode(options)).resolves.toBe('inout');
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly on a malformed capability or a changed session', async () => {
    mocks.request.mockResolvedValueOnce({ browserNavigationMode: 'fallback' });
    await expect(
      getBrowserNavigationMode({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).rejects.toThrow(/browser mode/i);

    mocks.request.mockResolvedValueOnce({ browserNavigationMode: 'inout' });
    await expect(
      getBrowserNavigationMode({
        signal: new AbortController().signal,
        isCurrent: () => false,
      }),
    ).rejects.toThrow(/session changed/i);
  });

  it('preserves typed capability changes and refetches only after invalidation', async () => {
    const options = {
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    await getBrowserNavigationMode(options);

    const error = toBrowserCapabilityError(new Error('capability-changed'));
    expect(error).toBeInstanceOf(BrowserCapabilityChangedError);
    expect(error).toMatchObject({ code: 'capability-changed' });
    mocks.request.mockResolvedValueOnce({ browserNavigationMode: 'inout' });

    await expect(getBrowserNavigationMode(options)).resolves.toBe('inout');
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
