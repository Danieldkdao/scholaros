import type { createAcademicTaskRunner } from './academic-tasks';

export const acquireConnectOwnership = async (
  accountId: string,
  tasks: ReturnType<typeof createAcademicTaskRunner>,
  suspend: () => () => void,
) => {
  const resumeSync = suspend();
  const ready = Promise.withResolvers<AbortSignal>();
  const finished = Promise.withResolvers<void>();
  const task = tasks.run(accountId, async (signal) => {
    ready.resolve(signal);
    await finished.promise;
  });
  void task.catch(ready.reject).finally(resumeSync);
  try {
    const signal = await ready.promise;
    return { signal, release: () => finished.resolve() };
  } catch (error) {
    await task.catch(() => undefined);
    throw error;
  }
};
