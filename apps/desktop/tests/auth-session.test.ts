import { describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const cookieMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.mock('../src/lib/auth/client', () => ({
  authClient: { getCookie: cookieMock },
}));
vi.mock('../src/data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'http://localhost:3000' },
}));

const { getCurrentUser, markLocalSignOut } =
  await import('../src/lib/auth/main');

describe('local session reads', () => {
  it('returns signed out without contacting the server when no local cookie exists', async () => {
    cookieMock.mockReturnValue('');

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the account from the server when a local cookie exists', async () => {
    cookieMock.mockReturnValue('better-auth.session_token=token');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'student-a',
            name: 'Student',
            email: 'student@example.com',
            image: 'https://campus.example.edu/student.png',
            hasCompletedOnboarding: true,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(getCurrentUser()).resolves.toMatchObject({
      id: 'student-a',
      image: 'https://campus.example.edu/student.png',
      hasCompletedOnboarding: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats an unauthorized response as signed out', async () => {
    cookieMock.mockReturnValue('stale-cookie');
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it('distinguishes an unavailable account service from a signed-out session', async () => {
    cookieMock.mockReturnValue('better-auth.session_token=token');
    fetchMock.mockRejectedValue(new Error('Network unavailable'));

    await expect(getCurrentUser()).rejects.toThrow('Network unavailable');
  });

  it('stays locally signed out until a new credential appears', async () => {
    cookieMock.mockReturnValue('old-cookie');
    markLocalSignOut();
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    cookieMock.mockReturnValue('new-cookie');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'student-b',
            name: 'Next Student',
            email: 'next@example.com',
            hasCompletedOnboarding: false,
          },
        }),
        { status: 200 },
      ),
    );
    await expect(getCurrentUser()).resolves.toMatchObject({
      id: 'student-b',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

it('discards an account response that arrives after local sign-out', async () => {
  let release!: (response: Response) => void;
  cookieMock.mockReturnValue('pending-cookie');
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = getCurrentUser();
  markLocalSignOut();
  cookieMock.mockReturnValue('');
  release(
    Response.json({
      user: {
        id: 'old-user',
        name: 'Old',
        email: 'old@example.com',
        hasCompletedOnboarding: false,
      },
    }),
  );
  await expect(pending).resolves.toBeNull();
});
