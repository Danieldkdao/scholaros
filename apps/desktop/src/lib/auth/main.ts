import { net } from 'electron';
import { authClient } from './client';
import { clientEnv } from '../../data/env/client';
import type { CurrentUser } from '../../features/onboarding/types';

export const accountRequest = async (
  route: '/api/me' | '/api/onboarding' | '/api/agent',
  body?: unknown,
  signal?: AbortSignal,
) => {
  let response: Response;
  try {
    response = await net.fetch(new URL(route, clientEnv.VITE_API_URL).href, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: authClient.getCookie(),
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    // Chromium reports a missing listener as a bare error code, which reads like
    // an app fault; name the endpoint so the outage is obvious at a glance.
    throw new Error(
      `ScholarOS could not reach its services at ${clientEnv.VITE_API_URL}.`,
      { cause },
    );
  }
  if (response.status === 401) {
    invalidateAccountCache();
    return null;
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      typeof result?.error === 'string'
        ? result.error
        : 'Account services are unavailable. Please try again.',
    );
  }
  if (route === '/api/onboarding') invalidateAccountCache();
  return response.json();
};

let locallySignedOutCookie: string | null = null;
let cachedAccount: {
  cookie: string;
  user: CurrentUser;
  expiresAt: number;
} | null = null;
let cacheEpoch = 0;

export const invalidateAccountCache = () => {
  cacheEpoch += 1;
  cachedAccount = null;
};

export const markLocalSignOut = () => {
  invalidateAccountCache();
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
  if (cachedAccount?.cookie === cookie && cachedAccount.expiresAt > Date.now())
    return cachedAccount.user;
  const epoch = cacheEpoch;
  const result = await accountRequest('/api/me');
  const currentCookie = authClient.getCookie();
  if (!currentCookie.trim() || locallySignedOutCookie === cookie) return null;
  if (currentCookie !== cookie)
    throw new Error('Your session changed; please try again.');
  if (!result?.user?.id) return null;
  if (epoch !== cacheEpoch)
    throw new Error('Your session changed; please try again.');
  const user: CurrentUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    image: typeof result.user.image === 'string' ? result.user.image : null,
    hasCompletedOnboarding: result.user.hasCompletedOnboarding === true,
  };
  if (epoch === cacheEpoch)
    cachedAccount = { cookie, user, expiresAt: Date.now() + 30_000 };
  return user;
};
