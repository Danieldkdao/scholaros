import { net } from 'electron';
import { authClient } from './client';
import { clientEnv } from '../../data/env/client';
import type { CurrentUser } from '../../features/onboarding/types';

export const accountRequest = async (
  route: '/api/me' | '/api/onboarding' | '/api/agent',
  body?: unknown,
  signal?: AbortSignal,
) => {
  const response = await net.fetch(
    new URL(route, clientEnv.VITE_API_URL).href,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: authClient.getCookie(),
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 401) return null;
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      typeof result?.error === 'string'
        ? result.error
        : 'Account services are unavailable. Please try again.',
    );
  }
  return response.json();
};

let locallySignedOutCookie: string | null = null;

export const markLocalSignOut = () => {
  try {
    locallySignedOutCookie = authClient.getCookie();
  } catch {
    locallySignedOutCookie = '';
  }
};

export const getCurrentUser = async (): Promise<CurrentUser | null> => {
  // Signing out clears the local cookie first; a missing cookie is a
  // confirmed signed-out state, not an account-service outage.
  let cookie = '';
  try {
    cookie = authClient.getCookie();
  } catch {
    cookie = '';
  }
  if (!cookie.trim()) return null;
  // Do not trust a stale cookie between sign-out and a new authentication.
  if (locallySignedOutCookie !== null) {
    if (cookie === locallySignedOutCookie) return null;
    locallySignedOutCookie = null;
  }
  const result = await accountRequest('/api/me');
  const currentCookie = authClient.getCookie();
  if (!currentCookie.trim() || locallySignedOutCookie === cookie) return null;
  if (currentCookie !== cookie)
    throw new Error('Your session changed; please try again.');
  if (!result?.user?.id) return null;
  return {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    hasCompletedOnboarding: result.user.hasCompletedOnboarding === true,
  };
};
