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
