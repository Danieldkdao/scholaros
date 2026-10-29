import { describe, expect, it, vi } from 'vitest';
import { watchPreview } from '../lib/preview-channel';
import type { PreviewState } from '../types';

const stateFor = (
  accountId: string,
  overrides: Partial<PreviewState> = {},
): PreviewState => ({
  accountId,
  status: 'running',
  events: [],
  cards: [],
  message: null,
  ...overrides,
});

const setup = () => {
  const listeners = new Set<(state: PreviewState) => void>();
  const subscribe = vi.fn((listener: (state: PreviewState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const emit = (state: PreviewState) => {
    for (const listener of listeners) listener(state);
  };
  const onState = vi.fn();
  const onNotice = vi.fn();
  const onSessionExpired = vi.fn();
  const schedules: Array<() => void> = [];
  const schedule = vi.fn((callback: () => void) => {
    schedules.push(callback);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  const cancelSchedule = vi.fn();
  return {
    listeners,
    subscribe,
    emit,
    onState,
    onNotice,
    onSessionExpired,
    schedule,
    cancelSchedule,
    schedules,
  };
};

describe('preview progress channel', () => {
  it('recovers from a temporary read failure and receives completion', async () => {
    const harness = setup();
    const fetchPreview = vi
      .fn<() => Promise<PreviewState>>()
      .mockRejectedValueOnce(new Error('Temporary note read failure'))
      .mockResolvedValue(stateFor('student-a', { status: 'complete' }));

    const watcher = watchPreview({
      accountId: 'student-a',
      fetchPreview,
      subscribe: harness.subscribe,
      onState: harness.onState,
      onNotice: harness.onNotice,
      onSessionExpired: harness.onSessionExpired,
      schedule: harness.schedule,
      cancelSchedule: harness.cancelSchedule,
    });
    await vi.waitFor(() => expect(fetchPreview).toHaveBeenCalledOnce());
    expect(harness.onNotice).toHaveBeenCalledWith(
      'Reconnecting to preview progress…',
    );
    harness.schedules[0]!();
    await vi.waitFor(() =>
      expect(harness.onState).toHaveBeenCalledWith(
        stateFor('student-a', { status: 'complete' }),
      ),
    );
    watcher.stop();
    expect(harness.cancelSchedule).toHaveBeenCalled();
  });

  it('stops retrying when the account session has expired', async () => {
    const harness = setup();
    const fetchPreview = vi
      .fn<() => Promise<PreviewState>>()
      .mockRejectedValue(new Error('Please sign in to ScholarOS.'));

    const watcher = watchPreview({
      accountId: 'student-a',
      fetchPreview,
      subscribe: harness.subscribe,
      onState: harness.onState,
      onNotice: harness.onNotice,
      onSessionExpired: harness.onSessionExpired,
      schedule: harness.schedule,
      cancelSchedule: harness.cancelSchedule,
    });
    await vi.waitFor(() =>
      expect(harness.onSessionExpired).toHaveBeenCalledWith(
        'Your session expired. Sign in again to see progress.',
      ),
    );
    expect(harness.schedule).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('reports a persistent read failure after bounded retries', async () => {
    const harness = setup();
    const fetchPreview = vi
      .fn<() => Promise<PreviewState>>()
      .mockRejectedValue(new Error('Local preview store unavailable'));

    const watcher = watchPreview({
      accountId: 'student-a',
      fetchPreview,
      subscribe: harness.subscribe,
      onState: harness.onState,
      onNotice: harness.onNotice,
      onSessionExpired: harness.onSessionExpired,
      schedule: harness.schedule,
      cancelSchedule: harness.cancelSchedule,
      maxRetries: 2,
    });
    await vi.waitFor(() => expect(harness.schedule).toHaveBeenCalled());
    harness.schedules[0]!();
    await vi.waitFor(() => expect(harness.schedules).toHaveLength(2));
    harness.schedules[1]!();
    await vi.waitFor(() =>
      expect(harness.onNotice).toHaveBeenLastCalledWith(
        'Local preview store unavailable',
      ),
    );
    watcher.stop();
  });

  it('stops callbacks and cancels work after unmount', async () => {
    const harness = setup();
    const fetchPreview = vi.fn(async () =>
      stateFor('student-a', { status: 'idle' }),
    );
    const watcher = watchPreview({
      accountId: 'student-a',
      fetchPreview,
      subscribe: harness.subscribe,
      onState: harness.onState,
      onNotice: harness.onNotice,
      onSessionExpired: harness.onSessionExpired,
      schedule: harness.schedule,
      cancelSchedule: harness.cancelSchedule,
    });
    await vi.waitFor(() => expect(harness.onState).toHaveBeenCalled());
    watcher.stop();
    harness.emit(stateFor('student-a', { status: 'complete' }));
    expect(harness.onState).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
  });

  it('ignores progress belonging to another account', async () => {
    const harness = setup();
    const fetchPreview = vi.fn(async () =>
      stateFor('student-b', { status: 'blocked' }),
    );
    const watcher = watchPreview({
      accountId: 'student-a',
      fetchPreview,
      subscribe: harness.subscribe,
      onState: harness.onState,
      onNotice: harness.onNotice,
      onSessionExpired: harness.onSessionExpired,
      schedule: harness.schedule,
      cancelSchedule: harness.cancelSchedule,
    });
    await vi.waitFor(() => expect(fetchPreview).toHaveBeenCalled());
    harness.emit(stateFor('student-b', { status: 'complete' }));
    expect(harness.onState).not.toHaveBeenCalled();
    harness.emit(stateFor('student-a', { status: 'running' }));
    expect(harness.onState).toHaveBeenCalledOnce();
    watcher.stop();
  });
});
