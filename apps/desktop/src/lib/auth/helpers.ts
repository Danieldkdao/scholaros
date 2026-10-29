import type { CurrentUser } from '../../features/onboarding/types';

export const getCurrentUser = async (): Promise<CurrentUser | null> =>
  window.scholar.getCurrentUser();
