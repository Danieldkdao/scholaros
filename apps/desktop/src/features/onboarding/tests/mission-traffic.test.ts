import { expect, it, vi } from 'vitest';
import { createMissionTrafficController } from '../services/mission-traffic';

const setup = () => {
  let now = 0;
  const sleep = vi.fn(async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    now += ms;
  });
  const traffic = createMissionTrafficController({
    now: () => now,
    sleep,
    intervalMs: 2000,
  });
  return {
    traffic,
    sleep,
    advance: (ms: number) => {
      now += ms;
    },
  };
};
it('spaces navigations across jobs for the same school, without delaying a different school', async () => {
  const { traffic, sleep } = setup();
  const signal = new AbortController().signal;
  await traffic.waitForTurn('https://school.example/home', signal);
  await traffic.waitForTurn('https://other.example/home', signal);
  expect(sleep).not.toHaveBeenCalled();
  await traffic.waitForTurn('https://school.example/courses', signal);
  expect(sleep).toHaveBeenCalledWith(2000, signal);
});
it('respects Retry-After cooldowns across later attempts', async () => {
  const { traffic, advance } = setup();
  expect(
    traffic.recordRateLimit('https://school.example/home', '120').message,
  ).toContain('120 seconds');
  await expect(
    traffic.waitForTurn(
      'https://school.example/courses',
      new AbortController().signal,
    ),
  ).rejects.toThrow('slow down');
  advance(120000);
  await expect(
    traffic.waitForTurn(
      'https://school.example/courses',
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
});
it('accepts HTTP dates and stops on a rate-limit page returned with status 200', async () => {
  const { traffic } = setup();
  traffic.recordRateLimit(
    'https://school.example/',
    new Date(60000).toUTCString(),
  );
  await expect(
    traffic.waitForTurn(
      'https://school.example/',
      new AbortController().signal,
    ),
  ).rejects.toThrow('60 seconds');
  expect(() =>
    traffic.assertPageContent(
      'https://other.example/',
      'Too many requests. Please try again later.',
    ),
  ).toThrow('slow down');
});
it('honors cancellation and an extended cooldown while waiting', async () => {
  let now = 0;
  let traffic: ReturnType<typeof createMissionTrafficController>;
  traffic = createMissionTrafficController({
    now: () => now,
    intervalMs: 2000,
    sleep: async (ms) => {
      now += ms;
      traffic.recordRateLimit('https://school.example/', '30');
    },
  });
  await traffic.waitForTurn(
    'https://school.example/',
    new AbortController().signal,
  );
  await expect(
    traffic.waitForTurn(
      'https://school.example/courses',
      new AbortController().signal,
    ),
  ).rejects.toThrow('slow down');
  const controller = new AbortController();
  controller.abort();
  await expect(
    traffic.waitForTurn('https://other.example/', controller.signal),
  ).rejects.toThrow();
});

it('applies the configured delay across parallel workers and rejects invalid delays', async () => {
  const { traffic, sleep } = setup();
  const signal = new AbortController().signal;
  traffic.setIntervalSeconds(0.5);
  await Promise.all([
    traffic.waitForTurn('https://school.example/a', signal),
    traffic.waitForTurn('https://school.example/b', signal),
  ]);
  expect(sleep).toHaveBeenCalledWith(500, signal);
  for (const value of [0, -1, 5.1, NaN])
    expect(() => traffic.setIntervalSeconds(value)).toThrow();
});
