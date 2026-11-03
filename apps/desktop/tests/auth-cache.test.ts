import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
const cookieMock = vi.hoisted(() => vi.fn());
const offlineAccountMocks = vi.hoisted(() => ({
  save: vi.fn(async () => true),
  read: vi.fn(
    async (): Promise<{
      id: string;
      name: string;
      email: string;
      image: string | null;
      hasCompletedOnboarding: boolean;
      authMode?: 'online' | 'offline-local';
    } | null> => null,
  ),
  clear: vi.fn(async (_cookie?: string) => undefined),
}));
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.mock('../src/lib/auth/client', () => ({
  authClient: { getCookie: cookieMock },
}));
vi.mock('../src/lib/offline-account', () => ({
  saveOfflineAccountGrant: offlineAccountMocks.save,
  readOfflineAccountGrant: offlineAccountMocks.read,
  clearOfflineAccountGrant: offlineAccountMocks.clear,
}));
vi.mock('../src/data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'http://localhost:3000' },
}));
const { getCurrentUser, invalidateAccountCache, markLocalSignOut } =
  await import('../src/lib/auth/main');
const account = () =>
  Response.json({
    user: {
      id: 'student',
      name: 'Student',
      email: 's@example.edu',
      hasCompletedOnboarding: false,
    },
  });
beforeEach(() => {
  vi.resetAllMocks();
  invalidateAccountCache();
  offlineAccountMocks.save.mockResolvedValue(true);
  offlineAccountMocks.read.mockResolvedValue(null);
  offlineAccountMocks.clear.mockResolvedValue(undefined);
  cookieMock.mockReturnValue('cookie-a');
  fetchMock.mockImplementation(async () => account());
});
it('does not issue a grant for an authenticated but unconfigured account', async () => {
  await expect(getCurrentUser(async () => false)).resolves.toMatchObject({
    id: 'student',
  });
  expect(offlineAccountMocks.save).not.toHaveBeenCalled();
});

it('rejects an existing grant when device setup is not ready', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  offlineAccountMocks.read.mockResolvedValueOnce({
    id: 'student',
    name: 'Student',
    email: 's@example.edu',
    image: null,
    hasCompletedOnboarding: true,
    authMode: 'offline-local',
  });
  await expect(getCurrentUser(async () => false)).rejects.toThrow(
    'could not reach',
  );
});

it('fails closed when readiness cannot be read without blocking online login', async () => {
  const unavailable = () => {
    throw new Error('database unavailable');
  };
  await expect(getCurrentUser(unavailable)).resolves.toMatchObject({
    id: 'student',
  });
  expect(offlineAccountMocks.save).not.toHaveBeenCalled();
  invalidateAccountCache();
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  offlineAccountMocks.read.mockResolvedValueOnce({
    id: 'student',
    name: 'Student',
    email: 's@example.edu',
    image: null,
    hasCompletedOnboarding: true,
    authMode: 'offline-local',
  });
  await expect(getCurrentUser(unavailable)).rejects.toThrow('could not reach');
});

it('fences an offline grant if the session changes during readiness', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  offlineAccountMocks.read.mockResolvedValueOnce({
    id: 'student',
    name: 'Student',
    email: 's@example.edu',
    image: null,
    hasCompletedOnboarding: true,
    authMode: 'offline-local',
  });
  let release!: (ready: boolean) => void;
  let started!: () => void;
  const checkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = getCurrentUser(() => {
    started();
    return new Promise<boolean>((resolve) => {
      release = resolve;
    });
  });
  await checkStarted;
  invalidateAccountCache();
  release(true);
  await expect(pending).rejects.toThrow('could not reach');
});

describe('account cache', () => {
  it('stores a device-bound grant only after successful online authentication', async () => {
    await getCurrentUser(() => true);

    expect(offlineAccountMocks.save).toHaveBeenCalledWith(
      {
        id: 'student',
        name: 'Student',
        email: 's@example.edu',
        image: null,
        hasCompletedOnboarding: false,
      },
      'cookie-a',
    );
  });
  it('uses an unexpired host grant only when the account request cannot connect', async () => {
    const offlineUser = {
      id: 'student',
      name: 'Student',
      email: 's@example.edu',
      image: null,
      hasCompletedOnboarding: false,
      authMode: 'offline-local' as const,
    };
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    offlineAccountMocks.read.mockResolvedValueOnce(offlineUser);

    await expect(getCurrentUser(() => true)).resolves.toEqual(offlineUser);
  });
  it('clears the offline grant after a confirmed unauthorized response', async () => {
    cookieMock.mockReturnValue('invalid-cookie');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(offlineAccountMocks.clear).toHaveBeenCalledWith('invalid-cookie');
    expect(offlineAccountMocks.read).not.toHaveBeenCalled();
  });
  it('reuses a recent verified account and refreshes after expiry', async () => {
    vi.useFakeTimers();
    try {
      await getCurrentUser();
      await getCurrentUser();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_001);
      await getCurrentUser();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not reuse the account after a cookie change or local sign out', async () => {
    await getCurrentUser();
    cookieMock.mockReturnValue('cookie-b');
    await getCurrentUser();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    markLocalSignOut();
    expect(await getCurrentUser()).toBeNull();
    cookieMock.mockReturnValue('cookie-c');
    await getCurrentUser();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not cache failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(getCurrentUser()).rejects.toThrow();
    await getCurrentUser();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it('rejects a pending account response after cache invalidation', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = getCurrentUser();
  invalidateAccountCache();
  release(account());
  await expect(pending).rejects.toThrow('session changed');
});
