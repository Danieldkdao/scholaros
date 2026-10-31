import { expect, it, vi } from 'vitest';
import { createConnectRun } from '../services/connect-run';

const candidate = {
  name: 'School',
  url: 'https://school.edu/',
  provider: 'unknown' as const,
};
it('pauses on sign-in until the user resumes and blocks a repeated sign-in', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValue({ status: 'sign-in', host: 'login.school.edu' });
  const capture = vi.fn();
  const run = createConnectRun({ inspect, capture });
  const completion = run.start('student', [candidate]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  expect(inspect).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  run.resume('student');
  await completion;
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'blocked' },
  ]);
  expect(capture).not.toHaveBeenCalled();
});
it('rejects a second run and cancels a paused run', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValue({ status: 'sign-in', host: 'school.edu' });
  const run = createConnectRun({ inspect, capture: vi.fn() });
  const completion = run.start('student', [candidate]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  await expect(run.start('student', [candidate])).rejects.toThrow();
  run.cancel('student');
  await completion;
  expect(run.getState('student').status).toBe('cancelled');
});
it('handles an unfamiliar sign-in service without a student-configured host', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'sign-in', host: 'identity.school.edu' })
    .mockResolvedValueOnce({ status: 'readable', host: 'school.edu' });
  const capture = vi.fn(async () => undefined);
  const prepareHandoff = vi.fn(async () => undefined);
  const run = createConnectRun({ inspect, capture, prepareHandoff });
  run.subscribe((state) => {
    if (state.status === 'awaiting-user') run.resume('student');
  });
  await run.start('student', [candidate]);
  expect(prepareHandoff).toHaveBeenCalledWith(
    candidate.url,
    expect.any(AbortSignal),
  );
  expect(capture).toHaveBeenCalledOnce();
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'connected' },
  ]);
});

it('can be resumed immediately by a listener without losing the signal', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'sign-in', host: 'school.edu' })
    .mockResolvedValueOnce({ status: 'readable', host: 'school.edu' });
  const capture = vi.fn(async () => undefined);
  const run = createConnectRun({ inspect, capture });
  run.subscribe((state) => {
    if (state.status === 'awaiting-user') run.resume('student');
  });
  const promise = run.start('student', [candidate]);
  await expect(
    Promise.race([
      promise.then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 100)),
    ]),
  ).resolves.toBe('finished');
  expect(capture).toHaveBeenCalledOnce();
  run.cancel('student');
});

it('reset cancels a pending handoff and clears account-visible state', async () => {
  const run = createConnectRun({
    inspect: vi
      .fn()
      .mockResolvedValue({ status: 'sign-in', host: 'school.edu' }),
    capture: vi.fn(),
  });
  const completion = run.start('student', [candidate]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  run.reset();
  await completion;
  expect(run.getState('student').status).toBe('idle');
});

it('continues to the next host after a blocked inspection', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'blocked', host: 'school.edu' })
    .mockResolvedValueOnce({ status: 'readable', host: 'other.edu' });
  const capture = vi.fn(async () => undefined);
  const run = createConnectRun({ inspect, capture });
  await run.start('student', [
    candidate,
    { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
  ]);
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'blocked' },
    { host: 'other.edu', status: 'connected' },
  ]);
});
it('does not start a run without approved sites', async () => {
  const run = createConnectRun({ inspect: vi.fn(), capture: vi.fn() });
  await expect(run.start('student', [])).rejects.toThrow();
});

it('stops an awaiting run when its browser-work owner aborts', async () => {
  const run = createConnectRun({
    inspect: vi
      .fn()
      .mockResolvedValue({ status: 'sign-in', host: 'school.edu' }),
    capture: vi.fn(),
  });
  const owner = new AbortController();
  const completion = run.start('student', [candidate], owner.signal);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  owner.abort();
  await completion;
  expect(run.getState('student').status).toBe('cancelled');
});

it('lets each approved site complete sign-in even when they share an identity service', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'sign-in', host: 'accounts.google.com' })
    .mockResolvedValueOnce({ status: 'readable', host: 'school.edu' })
    .mockResolvedValueOnce({ status: 'sign-in', host: 'accounts.google.com' })
    .mockResolvedValueOnce({ status: 'readable', host: 'other.edu' });
  const prepareHandoff = vi.fn(async () => undefined);
  const run = createConnectRun({
    inspect,
    prepareHandoff,
    capture: vi.fn(async () => undefined),
  });
  run.subscribe((state) => {
    if (state.status === 'awaiting-user') run.resume('student');
  });
  await run.start('student', [
    candidate,
    { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
  ]);
  expect(prepareHandoff).toHaveBeenCalledTimes(2);
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'connected' },
    { host: 'other.edu', status: 'connected' },
  ]);
});

it('reports when a captured page still needs confirmation', async () => {
  const run = createConnectRun({
    inspect: vi.fn(async () => ({
      status: 'readable' as const,
      host: 'school.edu',
    })),
    capture: vi.fn(async () => 'needs-sign-in' as const),
  });
  await run.start('student', [candidate]);
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'needs-sign-in' },
  ]);
});

it('names the destination along with the approved sign-in host during handoff', async () => {
  const run = createConnectRun({
    inspect: vi.fn(async () => ({
      status: 'sign-in' as const,
      host: 'login.school.edu',
    })),
    capture: vi.fn(async () => undefined),
  });
  const pending = run.start('student', [candidate]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  expect(run.getState('student').awaiting).toEqual({
    host: 'login.school.edu',
    destination: 'school.edu',
    note: null,
  });
  run.cancel('student');
  await pending;
});

it('includes the student’s site note during a handoff', async () => {
  const run = createConnectRun({
    inspect: vi.fn(async () => ({
      status: 'sign-in' as const,
      host: 'login.school.edu',
    })),
    capture: vi.fn(async () => undefined),
    noteForHost: () => 'Use the lab portal',
  });
  const pending = run.start('student', [candidate]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  expect(run.getState('student').awaiting?.note).toBe('Use the lab portal');
  run.cancel('student');
  await pending;
});

it('blocks a timed-out site and continues to the next one', async () => {
  vi.useFakeTimers();
  try {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ status: 'sign-in', host: 'school.edu' })
      .mockResolvedValueOnce({ status: 'readable', host: 'other.edu' });
    const run = createConnectRun({
      inspect,
      capture: vi.fn(async () => undefined),
    });
    const completion = run.start('student', [
      candidate,
      { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.getState('student').status).toBe('awaiting-user');
    await vi.advanceTimersByTimeAsync(300_000);
    await completion;
    expect(run.getState('student').results).toEqual([
      { host: 'school.edu', status: 'blocked' },
      { host: 'other.edu', status: 'connected' },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('prepares the student-controlled browser tab before publishing the handoff', async () => {
  let finish!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const run = createConnectRun({
    inspect: vi.fn(async () => ({
      status: 'sign-in' as const,
      host: 'school.edu',
    })),
    capture: vi.fn(async () => undefined),
    prepareHandoff: prepare,
  });
  const pending = run.start('student', [candidate]);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(run.getState('student').status).toBe('running');
  finish();
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  run.cancel('student');
  await pending;
});
