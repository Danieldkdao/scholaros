import { missionTraffic } from '../services/mission-traffic';
import { expect, it, vi } from 'vitest';
import { createMissionNavigator } from '../services/mission-navigation';
import { createAccountContinuation } from '../services/account-continuation';

it('reloads the current academic page instead of replaying a sign-in entry URL when assets are learned', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://school.example/home',
    evaluate: vi.fn(async () => ['https://assets.example.test']),
  };
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  await createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
  )(page as never, 'https://school.example/entry');
  expect(page.goto).toHaveBeenCalledOnce();
  expect(page.reload).toHaveBeenCalledOnce();
});

it('loads observed identity-provider scripts before trying the account picker', async () => {
  let assetsReady = false;
  const context = {
    setDomainPolicy: vi.fn(
      async ({ allowedDomains }: { allowedDomains: string[] }) => {
        assetsReady = allowedDomains.includes('accounts-assets.example.net');
      },
    ),
  };
  let current = 'https://accounts.google.com/v3/signin/accountchooser';
  const session = createAccountContinuation(
    'school.example',
    'Choose student@example.edu.',
    '',
  );
  session.resume = vi.fn(async () => {
    expect(assetsReady).toBe(true);
    current = 'https://school.example/courses';
  });
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => current,
    evaluate: vi.fn(async () => ['https://accounts-assets.example.net']),
  };
  await createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
  )(page as never, 'https://school.example/', session);
  expect(session.resume).toHaveBeenCalledOnce();
});

it('loads newly observed academic scripts after returning from the picker', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  let current = 'https://accounts.google.com/v3/signin/accountchooser';
  const session = createAccountContinuation(
    'school.example',
    'Choose student@example.edu.',
    '',
  );
  session.resume = vi.fn(async () => {
    current = 'https://school.example/courses';
  });
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => current,
    evaluate: vi.fn(async () => [
      current.includes('accounts.google.com')
        ? 'https://accounts-assets.example.net'
        : 'https://school-assets.example.net',
    ]),
  };
  await createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
  )(page as never, 'https://school.example/', session);
  expect(context.setDomainPolicy).toHaveBeenCalledWith(
    expect.objectContaining({
      allowedDomains: expect.arrayContaining(['school-assets.example.net']),
    }),
  );
});

it('completes account selection before observing academic content and keeps provider domains out of navigation permissions', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  let current = 'https://accounts.google.com/v3/signin/accountchooser';
  const session = createAccountContinuation(
    'school.example',
    'Choose student@example.edu.',
    '',
  );
  session.resume = vi.fn(async () => {
    current = 'https://school.example/courses';
  });
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => current,
    evaluate: vi.fn(async () => []),
  };
  const navigate = createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
  );
  await navigate(page as never, 'https://school.example/', session);
  expect(session.resume).toHaveBeenCalled();
  expect(context.setDomainPolicy).toHaveBeenCalledWith({
    allowedDomains: ['school.example', 'accounts.google.com'],
    blockedDomains: [],
  });
  await expect(
    navigate(
      page as never,
      (current = 'https://accounts.google.com/v3/signin/accountchooser'),
    ),
  ).rejects.toThrow();
});

it('loads observed rendering hosts without authorizing them as navigation destinations', async () => {
  let cssAllowed = false;
  const setDomainPolicy = vi.fn(
    async (policy: { allowedDomains: string[] }) => {
      cssAllowed = policy.allowedDomains.includes('cdn.example.net');
    },
  );
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://school.example/',
    evaluate: vi.fn(async () => [
      'https://cdn.example.net',
      'https://127.0.0.1',
      'http://untrusted.example',
    ]),
  };
  const navigate = createMissionNavigator(
    { setDomainPolicy },
    ['school.example'],
    new AbortController().signal,
  );
  await navigate(page as never, 'https://school.example/');
  expect(cssAllowed).toBe(true);
  expect(setDomainPolicy).toHaveBeenCalledWith({
    allowedDomains: ['school.example', 'cdn.example.net'],
    blockedDomains: [],
  });
  expect(page.goto).toHaveBeenCalledOnce();
  expect(page.reload).toHaveBeenCalledOnce();
  await expect(
    navigate(page as never, 'https://cdn.example.net/'),
  ).rejects.toThrow();
});
it('does not reload pages without new rendering dependencies', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://school.example/',
    evaluate: vi.fn(async () => []),
  };
  await createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
  )(page as never, 'https://school.example/');
  expect(page.goto).toHaveBeenCalledOnce();
  expect(context.setDomainPolicy).not.toHaveBeenCalled();
});
it('stops before reloading after cancellation during dependency observation', async () => {
  const controller = new AbortController();
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://school.example/',
    evaluate: vi.fn(async () => {
      controller.abort();
      return ['https://cdn.example.net'];
    }),
  };
  await expect(
    createMissionNavigator(
      context,
      ['school.example'],
      controller.signal,
    )(page as never, 'https://school.example/'),
  ).rejects.toThrow();
  expect(page.goto).toHaveBeenCalledOnce();
  expect(context.setDomainPolicy).not.toHaveBeenCalled();
});

vi.mock('../services/mission-traffic', () => ({
  missionTraffic: {
    waitForTurn: vi.fn(async () => undefined),
    recordRateLimit: vi.fn(() => new Error('School cooldown')),
  },
}));
it('stops on a 429 response before dependency reloads', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  const page = {
    goto: vi.fn(async () => ({
      status: () => 429,
      headers: () => ({ 'retry-after': '120' }),
    })),
    url: async () => 'https://limited.example/',
    evaluate: vi.fn(async () => []),
  };
  await expect(
    createMissionNavigator(
      context,
      ['limited.example'],
      new AbortController().signal,
    )(page as never, 'https://limited.example/'),
  ).rejects.toThrow('cooldown');
  expect(missionTraffic.recordRateLimit).toHaveBeenCalledWith(
    'https://limited.example/',
    '120',
  );
  expect(page.evaluate).not.toHaveBeenCalled();
});
it('reuses rendering dependencies on a later mission for the same account', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://cached.example/',
    evaluate: vi.fn(async () => ['https://assets.example.net']),
  };
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  await createMissionNavigator(
    context,
    ['cached.example'],
    new AbortController().signal,
    undefined,
    { scopeId: 'student-cache' },
  )(page as never, 'https://cached.example/');
  page.goto.mockClear();
  context.setDomainPolicy.mockClear();
  await createMissionNavigator(
    context,
    ['cached.example'],
    new AbortController().signal,
    undefined,
    { scopeId: 'student-cache' },
  )(page as never, 'https://cached.example/');
  expect(page.goto).toHaveBeenCalledOnce();
  expect(context.setDomainPolicy).toHaveBeenCalledWith({
    allowedDomains: ['cached.example', 'assets.example.net'],
    blockedDomains: [],
  });
  expect(missionTraffic.waitForTurn).toHaveBeenCalled();
});
