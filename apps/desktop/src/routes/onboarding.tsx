import { createFileRoute } from '@tanstack/react-router';
import { OnboardingScreen } from '../features/onboarding/components/onboarding-screen';

export const Route = createFileRoute('/onboarding')({
  component: OnboardingScreen,
});
