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
  expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
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
  expect(sleep).toHaveBeenCalledWith(500, expect.any(AbortSignal));
  for (const value of [0, -1, 5.1, NaN])
    expect(() => traffic.setIntervalSeconds(value)).toThrow();
});

it('keeps minimum spacing when queued workers wake together after a clock stall', async () => {
  let now = 0;
  const sleepers: Array<{
    due: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
  }> = [];
  const traffic = createMissionTrafficController({
    now: () => now,
    intervalMs: 1000,
    sleep: (milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        sleepers.push({
          due: now + milliseconds,
          resolve,
          reject,
          signal,
        });
        signal.addEventListener(
          'abort',
          () => reject(new Error('sleep aborted')),
          { once: true },
        );
      }),
  });
  const starts: number[] = [];
  const signal = new AbortController().signal;
  await traffic
    .waitForTurn('https://school.example/1', signal)
    .then(() => starts.push(now));
  const second = traffic
    .waitForTurn('https://school.example/2', signal)
    .then(() => starts.push(now));
  const third = traffic
    .waitForTurn('https://school.example/3', signal)
    .then(() => starts.push(now));
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const advance = async (time: number) => {
    now = time;
    const pendingSleepers = sleepers.slice();
    for (const sleeper of pendingSleepers) {
      if (sleeper.due > now) continue;
      sleepers.splice(sleepers.indexOf(sleeper), 1);
      sleeper.resolve();
    }
    await flush();
  };

  await flush();
  await advance(5000);
  expect(starts).toEqual([0, 5000]);
  expect(sleepers.map((sleeper) => sleeper.due)).toEqual([6000]);
  await advance(6000);
  await Promise.all([second, third]);
  expect(starts).toEqual([0, 5000, 6000]);
});

it('uses the latest delay for workers that are already queued', async () => {
  let now = 0;
  const sleepers: Array<{
    due: number;
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
  }> = [];
  const traffic = createMissionTrafficController({
    now: () => now,
    intervalMs: 5000,
    sleep: (milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        const sleeper = { due: now + milliseconds, resolve, reject, signal };
        sleepers.push(sleeper);
        signal.addEventListener(
          'abort',
          () => {
            sleepers.splice(sleepers.indexOf(sleeper), 1);
            reject(new Error('sleep aborted'));
          },
          { once: true },
        );
      }),
  });
  const signal = new AbortController().signal;
  await traffic.waitForTurn('https://school.example/1', signal);
  let startedAt = -1;
  const queued = traffic
    .waitForTurn('https://school.example/2', signal)
    .then(() => {
      startedAt = now;
    });
  await Promise.resolve();
  traffic.setIntervalSeconds(0.5);
  await Promise.resolve();
  expect(sleepers.map((sleeper) => sleeper.due)).toEqual([500]);
  now = 500;
  sleepers[0]!.resolve();
  await queued;
  expect(startedAt).toBe(500);
});

it('keeps the host reserved through slow validation before a click is dispatched', async () => {
  let now = 0;
  const traffic = createMissionTrafficController({
    now: () => now,
    intervalMs: 1000,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
  let releaseInspection!: () => void;
  const inspection = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const starts: number[] = [];
  const signal = new AbortController().signal;
  const run = traffic.runTurn;
  const first = run('https://school.example/1', signal, async () => {
    await inspection;
    starts.push(now);
  });
  const second = run('https://school.example/2', signal, async () => {
    starts.push(now);
  });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  expect(starts).toEqual([]);
  releaseInspection();
  await Promise.all([first, second]);
  expect(starts).toEqual([0, 1000]);
});
