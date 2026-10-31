import { expect, it, vi } from 'vitest';
import { createConnectCoordinator } from '../services/connect-coordinator';
const candidate = {
  name: 'School',
  url: 'https://school.edu/',
  provider: 'unknown' as const,
};
it('holds ownership while paused and releases it after cancellation', async () => {
  const release = vi.fn();
  const close = vi.fn(async () => undefined);
  const browser = {
    inspect: vi.fn(async () => ({
      status: 'sign-in' as const,
      host: 'school.edu',
    })),
    capture: vi.fn(),
    close,
  };
  const coordinator = createConnectCoordinator({
    acquire: vi.fn(async () => ({
      release,
      signal: new AbortController().signal,
    })),
    browser: vi.fn(async () => browser),
  });
  await coordinator.start('student', {
    candidates: [candidate],
  });
  await vi.waitFor(() =>
    expect(coordinator.getState('student').status).toBe('awaiting-user'),
  );
  await expect(
    coordinator.start('student', {
      candidates: [candidate],
    }),
  ).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
  await coordinator.cancel('student');
  expect(close).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it('does not start the browser if reset occurs while acquiring ownership', async () => {
  let resolveAcquire!: (ownership: {
    release: () => void;
    signal: AbortSignal;
  }) => void;
  const release = vi.fn();
  const acquire = vi.fn(
    () =>
      new Promise<{ release: () => void; signal: AbortSignal }>((resolve) => {
        resolveAcquire = resolve;
      }),
  );
  const browser = vi.fn();
  const coordinator = createConnectCoordinator({ acquire, browser });
  const pending = coordinator.start('student', {
    candidates: [candidate],
  });
  coordinator.reset();
  resolveAcquire({ release, signal: new AbortController().signal });
  await expect(pending).rejects.toThrow();
  expect(browser).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it('stops the run if browser ownership is revoked externally', async () => {
  const owner = new AbortController();
  const release = vi.fn();
  const browser = {
    inspect: vi.fn(async () => ({
      status: 'sign-in' as const,
      host: 'school.edu',
    })),
    capture: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const coordinator = createConnectCoordinator({
    acquire: vi.fn(async () => ({ release, signal: owner.signal })),
    browser: vi.fn(async () => browser),
  });
  await coordinator.start('student', {
    candidates: [candidate],
  });
  await vi.waitFor(() =>
    expect(coordinator.getState('student').status).toBe('awaiting-user'),
  );
  owner.abort();
  await vi.waitFor(() => expect(release).toHaveBeenCalled());
  expect(coordinator.getState('student').status).toBe('cancelled');
});

it('releases ownership if browser setup fails after acquiring it', async () => {
  const release = vi.fn();
  const coordinator = createConnectCoordinator({
    acquire: vi.fn(async () => ({
      release,
      signal: new AbortController().signal,
    })),
    browser: vi.fn(async () => {
      throw new Error('Cannot start');
    }),
  });
  await expect(
    coordinator.start('student', {
      candidates: [candidate],
    }),
  ).rejects.toThrow('Cannot start');
  expect(release).toHaveBeenCalledOnce();
});

it('releases ownership even when cleanup fails during a cancelled setup', async () => {
  const release = vi.fn();
  let releaseBrowser!: (value: never) => void;
  const delayed = new Promise<never>((resolve) => {
    releaseBrowser = resolve;
  });
  const coordinator = createConnectCoordinator({
    acquire: vi.fn(async () => ({
      release,
      signal: new AbortController().signal,
    })),
    browser: vi.fn(() => delayed),
  });
  const pending = coordinator.start('student', {
    candidates: [candidate],
  });
  await vi.waitFor(() => expect(releaseBrowser).toBeTypeOf('function'));
  coordinator.reset();
  releaseBrowser({
    close: async () => {
      throw new Error('close failed');
    },
  } as never);
  await expect(pending).rejects.toThrow();
  expect(release).toHaveBeenCalledOnce();
});

it('reports a failed browser cleanup as blocked and releases ownership', async () => {
  const release = vi.fn();
  const browser = {
    inspect: vi.fn(async () => ({
      status: 'readable' as const,
      host: 'school.edu',
    })),
    capture: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      throw new Error('cleanup failed');
    }),
  };
  const coordinator = createConnectCoordinator({
    acquire: vi.fn(async () => ({
      release,
      signal: new AbortController().signal,
    })),
    browser: vi.fn(async () => browser),
  });
  await coordinator.start('student', {
    candidates: [candidate],
  });
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(coordinator.getState('student').status).toBe('blocked');
});
