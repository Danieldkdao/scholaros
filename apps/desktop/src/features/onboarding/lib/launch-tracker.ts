export const createLaunchTracker = () => {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      return generation;
    },
    cancel: () => {
      generation += 1;
    },
    isCurrent: (attempt: number) => attempt === generation,
  };
};

export type LaunchTracker = ReturnType<typeof createLaunchTracker>;
