import { missionTraffic } from '../services/mission-traffic';
import { expect, it, vi } from 'vitest';
import { createMissionNavigator } from '../services/mission-navigation';

it('loads observed rendering hosts without authorizing them as navigation destinations', async () => {
  let cssAllowed = false;
  const setDomainPolicy = vi.fn(
    async (policy: { allowedDomains: string[] }) => {
      cssAllowed = policy.allowedDomains.includes('cdn.example.net');
    },
  );
  const page = {
    goto: vi.fn(async () => undefined),
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
  expect(page.goto).toHaveBeenCalledTimes(2);
  await expect(
    navigate(page as never, 'https://cdn.example.net/'),
  ).rejects.toThrow();
});
it('does not reload pages without new rendering dependencies', async () => {
  const context = { setDomainPolicy: vi.fn(async () => undefined) };
  const page = {
    goto: vi.fn(async () => undefined),
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
