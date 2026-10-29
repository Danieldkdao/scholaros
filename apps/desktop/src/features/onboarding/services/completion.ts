import type { OnboardingState } from '../types';

type CompletionDependencies = {
  getState: (userId: string) => OnboardingState;
  cancelPreview: () => Promise<void>;
  markLocalComplete: (userId: string) => void;
  updateCloud: () => Promise<unknown>;
  isCurrent: () => boolean;
};

export const completeOnboarding = async (
  userId: string,
  dependencies: CompletionDependencies,
) => {
  const state = dependencies.getState(userId);
  if (!state.settings.consent || !state.workspace?.ready)
    throw new Error('Approve access and create your study browser first.');
  await dependencies.cancelPreview();
  if (!dependencies.isCurrent())
    throw new Error('Your session changed; sign in again.');
  // Local readiness persists first so a failed cloud update can be retried safely.
  dependencies.markLocalComplete(userId);
  const completed = await dependencies.updateCloud();
  if (!completed) throw new Error('Sign in again to finish onboarding.');
};
