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
describe('account cache', () => {
  it('stores a device-bound grant only after successful online authentication', async () => {
    await getCurrentUser();

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

    await expect(getCurrentUser()).resolves.toEqual(offlineUser);
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
