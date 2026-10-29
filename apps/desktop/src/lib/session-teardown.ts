type SessionTeardownDependencies = {
  invalidateSession: () => void;
  stopMissions: () => void;
  clearLocalSession: () => Promise<void>;
  closeBrowser: () => Promise<void>;
};

const bounded = <T>(promise: Promise<T>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return Promise.race([promise.then(() => undefined), timeout]).finally(() =>
    clearTimeout(timer),
  );
};

export const tearDownSession = async (
  dependencies: SessionTeardownDependencies,
  options: { clearBoundMs?: number } = {},
) => {
  dependencies.invalidateSession();
  dependencies.stopMissions();
  // The Electron auth client clears its local cookie before the request; wait
  // only briefly so an unreachable account service cannot retain this session.
  await bounded(
    dependencies.clearLocalSession().catch(() => undefined),
    options.clearBoundMs ?? 350,
  );
  // Chrome can take seconds to exit; the workspace bounds its own close.
  void dependencies.closeBrowser().catch(() => undefined);
};
