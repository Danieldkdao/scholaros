import { missionTraffic } from '../services/mission-traffic';
import { expect, it, vi } from 'vitest';
import { createMissionNavigator } from '../services/mission-navigation';
import { createAccountContinuation } from '../services/account-continuation';

it('resolves the live browser context after Stagehand replaces its RPC client', async () => {
  const closed = {
    setDomainPolicy: vi.fn(async (): Promise<void> => {
      throw new Error('RPC client is closed');
    }),
  };
  const fresh = { setDomainPolicy: vi.fn(async () => undefined) };
  let context = closed;
  const navigate = createMissionNavigator(
    () => context,
    ['live.school.edu'],
    new AbortController().signal,
  );
  context = fresh;
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://live.school.edu/courses',
    evaluate: vi.fn(async () => []),
  };
  const continuation = createAccountContinuation('live.school.edu', '', '');
  await navigate(
    page as never,
    'https://live.school.edu/courses',
    continuation,
  );
  expect(closed.setDomainPolicy).not.toHaveBeenCalled();
  expect(fresh.setDomainPolicy).toHaveBeenCalled();
  expect(page.goto).toHaveBeenCalledOnce();
});

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
  const onPageOpened = vi.fn();
  await createMissionNavigator(
    context,
    ['school.example'],
    new AbortController().signal,
    undefined,
    { onPageOpened },
  )(page as never, 'https://school.example/');
  expect(page.goto).toHaveBeenCalledOnce();
  expect(onPageOpened).toHaveBeenCalledOnce();
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
  const onPageOpened = vi.fn();
  await expect(
    createMissionNavigator(
      context,
      ['limited.example'],
      new AbortController().signal,
      undefined,
      { onPageOpened },
    )(page as never, 'https://limited.example/'),
  ).rejects.toThrow('cooldown');
  expect(missionTraffic.recordRateLimit).toHaveBeenCalledWith(
    'https://limited.example/',
    '120',
  );
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(onPageOpened).not.toHaveBeenCalled();
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

it('keeps shared rendering dependencies when independently created course navigators use the same workspace', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  const signal = new AbortController().signal;
  const first = createMissionNavigator(
    context,
    ['shared.school.edu'],
    signal,
    undefined,
    { scopeId: 'shared-worker-student' },
  );
  const second = createMissionNavigator(
    context,
    ['shared.school.edu'],
    signal,
    undefined,
    { scopeId: 'shared-worker-student' },
  );
  const page = (asset: string) => ({
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://shared.school.edu/courses/1',
    evaluate: vi.fn(async () => [asset]),
  });
  await first(
    page('https://first-assets.example.net') as never,
    'https://shared.school.edu/courses/1',
  );
  await second(
    page('https://second-assets.example.net') as never,
    'https://shared.school.edu/courses/2',
  );
  expect(context.setDomainPolicy).toHaveBeenLastCalledWith({
    allowedDomains: expect.arrayContaining([
      'first-assets.example.net',
      'second-assets.example.net',
    ]),
    blockedDomains: [],
  });
});

it('relearns rendering dependencies after the browser restarts while preserving reuse inside one browser', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    url: async () => 'https://restart.school.edu/',
    evaluate: vi.fn(async () => ['https://restart-assets.example.net']),
  };
  const firstContext = { setDomainPolicy: vi.fn(async () => undefined) };
  const run = (context: typeof firstContext) =>
    createMissionNavigator(
      context,
      ['restart.school.edu'],
      new AbortController().signal,
      undefined,
      { scopeId: 'restart-student' },
    )(page as never, 'https://restart.school.edu/');
  await run(firstContext);
  page.reload.mockClear();
  await run(firstContext);
  expect(page.reload).not.toHaveBeenCalled();
  const restartedContext = { setDomainPolicy: vi.fn(async () => undefined) };
  await run(restartedContext);
  expect(page.reload).toHaveBeenCalledOnce();
});
