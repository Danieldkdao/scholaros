export type SessionGuard = {
  begin: () => number;
  isCurrent: (epoch: number) => boolean;
  invalidate: () => void;
};

export const createSessionGuard = (): SessionGuard => {
  let epoch = 0;
  return {
    begin: () => epoch,
    isCurrent: (captured) => captured === epoch,
    invalidate: () => {
      epoch += 1;
    },
  };
};

// Bridges run against the session that started them; a response that finishes
// after sign-out must never reach the next account.
export const runSessionAction = async <T>(
  guard: SessionGuard,
  action: (isCurrent: () => boolean) => Promise<T>,
): Promise<T> => {
  const epoch = guard.begin();
  const isCurrent = () => guard.isCurrent(epoch);
  const result = await action(isCurrent);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  return result;
};
