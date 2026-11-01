import { describe, expect, it, vi } from 'vitest';
import { createAcademicTaskRunner } from '../services/academic-tasks';

describe('academic browser task ownership', () => {
  it('rejects overlapping discovery and preview until the first task finishes', async () => {
    const runner = createAcademicTaskRunner();
    let release!: () => void;
    const first = runner.run(
      'student-a',
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const second = vi.fn(async () => undefined);
    await expect(runner.run('student-a', second)).rejects.toThrow(
      'Another academic task',
    );
    expect(second).not.toHaveBeenCalled();
    release();
    await first;
    await expect(runner.run('student-a', second)).resolves.toBeUndefined();
  });
  it('does not release the browser policy lease until cancellation cleanup completes', async () => {
    const runner = createAcademicTaskRunner();
    let cleanup!: () => void;
    const task = runner.run(
      'student-a',
      async (signal) =>
        new Promise<void>((resolve) => {
          cleanup = resolve;
          signal.addEventListener('abort', () => undefined);
        }),
    );
    await Promise.resolve();
    await expect(runner.cancelAndWait(5)).rejects.toThrow('Stopping');
    await expect(
      runner.run('student-b', async () => undefined),
    ).rejects.toThrow('Another academic task');
    cleanup();
    await task;
    await expect(
      runner.run('student-b', async () => undefined),
    ).resolves.toBeUndefined();
  });
  it('cancels a queued task before it begins any browser operations', async () => {
    const runner = createAcademicTaskRunner();
    const action = vi.fn(async () => undefined);
    const task = runner.run('student-a', action);
    runner.cancel();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(action).not.toHaveBeenCalled();
  });
});

it('runs different courses together, joins duplicates, rejects exclusive work, and cancels all', async () => {
  const runner = createAcademicTaskRunner();
  const signals: AbortSignal[] = [];
  const action = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const a = runner.run('student', action, undefined, 'course-a');
  const b = runner.run('student', action, undefined, 'course-b');
  await Promise.resolve();
  expect(signals).toHaveLength(2);
  expect(runner.run('student', action, undefined, 'course-a')).toBe(a);
  await expect(
    runner.run('other', action, undefined, 'course-c'),
  ).rejects.toThrow('Another academic task');
  await expect(runner.run('student', action)).rejects.toThrow(
    'Another academic task',
  );
  await runner.cancelAndWait();
  await Promise.all([a, b]);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await expect(
    runner.run('student', async () => undefined),
  ).resolves.toBeUndefined();
});

it('joins equivalent all-course refreshes and keeps them exclusive with targeted refreshes', async () => {
  const runner = createAcademicTaskRunner();
  const action = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
  );
  const first = runner.run('student', action, undefined, 'courses');
  expect(runner.run('student', action, undefined, 'courses')).toBe(first);
  await Promise.resolve();
  await expect(
    runner.run('student', action, undefined, 'course-1'),
  ).rejects.toThrow('Another academic task');
  expect(action).toHaveBeenCalledOnce();
  await runner.cancelAndWait();
});

it('reports active refresh scopes and publishes both job start and completion', async () => {
  const runner = createAcademicTaskRunner();
  const changed = vi.fn();
  const unsubscribe = runner.subscribe(changed);
  let finish!: () => void;
  const task = runner.run(
    'student',
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    undefined,
    'course-1',
  );
  await Promise.resolve();
  expect(runner.getRefreshState('student')).toEqual({
    allCourses: false,
    courseIds: ['course-1'],
  });
  expect(runner.getRefreshState('other')).toEqual({
    allCourses: false,
    courseIds: [],
  });
  finish();
  await task;
  expect(runner.getRefreshState('student')).toEqual({
    allCourses: false,
    courseIds: [],
  });
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it('cancels only the requested course for the authenticated account', async () => {
  const runner = createAcademicTaskRunner();
  const signals: AbortSignal[] = [];
  const action = async (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const a = runner.run('student', action, undefined, 'a');
  const b = runner.run('student', action, undefined, 'b');
  await Promise.resolve();
  runner.cancel('other', 'a');
  expect(signals[0].aborted).toBe(false);
  runner.cancel('student', 'a');
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  runner.cancel();
  await Promise.all([a, b]);
});

it('publishes scoped progress, retains completion, and distinguishes cancellation from failure', async () => {
  const runner = createAcademicTaskRunner();
  await runner.run(
    'student',
    async (signal) => {
      runner.report(signal, 'Reading assignments');
      expect(runner.getActivity('student')[0].events).toContain(
        'Reading assignments',
      );
      expect(runner.getActivity('other')).toEqual([]);
    },
    undefined,
    'course-1',
  );
  expect(runner.getActivity('student')[0].status).toBe('complete');
  const cancelled = runner.run(
    'student',
    async () => undefined,
    undefined,
    'course-2',
  );
  runner.cancel('student', 'course-2');
  await expect(cancelled).rejects.toThrow();
  expect(
    runner.getActivity('student').find((run) => run.key === 'course-2')?.status,
  ).toBe('cancelled');
  await expect(
    runner.run(
      'student',
      async () => {
        throw new Error('Offline');
      },
      undefined,
      'course-3',
    ),
  ).rejects.toThrow('Offline');
  expect(
    runner.getActivity('student').find((run) => run.key === 'course-3')?.status,
  ).toBe('failed');
});
