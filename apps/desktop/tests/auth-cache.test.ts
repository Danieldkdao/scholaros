import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
const cookieMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.mock('../src/lib/auth/client', () => ({
  authClient: { getCookie: cookieMock },
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
  cookieMock.mockReturnValue('cookie-a');
  fetchMock.mockImplementation(async () => account());
});
describe('account cache', () => {
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
