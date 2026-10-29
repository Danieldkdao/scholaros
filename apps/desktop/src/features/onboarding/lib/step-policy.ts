import { onboardingSteps } from '../schemas';
import type { OnboardingState, OnboardingStep } from '../types';

const hasReadyWorkspace = (state: OnboardingState) =>
  state.workspace?.ready === true;

export const canStartOnboardingStep = (
  state: OnboardingState,
  step: OnboardingStep,
) => {
  switch (step) {
    case 'welcome':
      return true;
    case 'browser':
      return state.settings.consent;
    case 'resources':
    case 'context':
    case 'preferences':
    case 'preview':
    case 'review':
      return state.settings.consent && hasReadyWorkspace(state);
  }
};

export const resumeOnboardingStep = (
  state: OnboardingState,
): OnboardingStep => {
  const savedIndex = onboardingSteps.indexOf(state.settings.step);
  for (let index = savedIndex; index >= 0; index -= 1) {
    const step = onboardingSteps[index];
    if (canStartOnboardingStep(state, step)) return step;
  }
  return 'welcome';
};

export const adjacentOnboardingStep = (
  step: OnboardingStep,
  direction: -1 | 1,
): OnboardingStep | null => {
  const index = onboardingSteps.indexOf(step) + direction;
  return onboardingSteps[index] ?? null;
};

export const canCompleteOnboarding = (state: OnboardingState) =>
  state.settings.consent && hasReadyWorkspace(state);

export const needsDeviceSetup = (state: OnboardingState) =>
  !hasReadyWorkspace(state);
