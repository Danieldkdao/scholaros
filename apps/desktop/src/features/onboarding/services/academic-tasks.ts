type AcademicTask = {
  accountId: string;
  controller: AbortController;
  completion: Promise<unknown>;
};

export const createAcademicTaskRunner = () => {
  let active: AcademicTask | null = null;
  const run = <T>(
    accountId: string,
    action: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> => {
    if (active)
      return Promise.reject(
        new Error(
          'Another academic task is running; stop it or try again shortly.',
        ),
      );
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const completion = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action(signal);
      })
      .finally(() => {
        if (active?.completion === completion) active = null;
      });
    active = { accountId, controller, completion };
    return completion;
  };
  const cancel = () => {
    active?.controller.abort();
  };
  const cancelAndWait = async (timeoutMs = 2500) => {
    const task = active;
    if (!task) return;
    task.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task.completion.catch(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Stopping the previous academic task; try again shortly.',
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { run, cancel, cancelAndWait };
};
export const academicTasks = createAcademicTaskRunner();
