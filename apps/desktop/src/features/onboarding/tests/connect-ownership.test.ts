import { expect, it, vi } from 'vitest';
import { createAcademicTaskRunner } from '../services/academic-tasks';
import { acquireConnectOwnership } from '../services/connect-ownership';

it('holds academic single-flight and suspends sync until the owner releases', async () => {
  const tasks = createAcademicTaskRunner();
  const releaseSync = vi.fn();
  const owner = await acquireConnectOwnership(
    'student',
    tasks,
    () => releaseSync,
  );
  await expect(tasks.run('student', async () => undefined)).rejects.toThrow();
  expect(releaseSync).not.toHaveBeenCalled();
  owner.release();
  await vi.waitFor(() => expect(releaseSync).toHaveBeenCalledOnce());
  await expect(tasks.run('student', async () => 'ok')).resolves.toBe('ok');
});
it('releases sync after failed acquisition', async () => {
  const tasks = createAcademicTaskRunner();
  let finish!: () => void;
  const held = tasks.run(
    'student',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const releaseSync = vi.fn();
  await expect(
    acquireConnectOwnership('student', tasks, () => releaseSync),
  ).rejects.toThrow();
  expect(releaseSync).toHaveBeenCalledOnce();
  finish();
  await held;
});
