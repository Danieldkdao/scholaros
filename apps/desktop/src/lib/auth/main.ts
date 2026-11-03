import { net } from 'electron';
import { authClient } from './client';
import {
  clearOfflineAccountGrant,
  readOfflineAccountGrant,
  saveOfflineAccountGrant,
} from '../offline-account';
import { clientEnv } from '../../data/env/client';
import type { CurrentUser } from '../../features/onboarding/types';

export const accountRequest = async (
  route: '/api/me' | '/api/onboarding' | '/api/agent',
  body?: unknown,
  signal?: AbortSignal,
) => {
  let response: Response;
  const cookie = authClient.getCookie();
  try {
    response = await net.fetch(new URL(route, clientEnv.VITE_API_URL).href, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(route === '/api/agent' ? 65_000 : 15_000),
      ]),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    // Chromium reports a missing listener as a bare error code, which reads like
    // an app fault; name the endpoint so the outage is obvious at a glance.
    throw new Error(
      `ScholarOS could not reach its services at ${clientEnv.VITE_API_URL}.`,
      { cause },
    );
  }
  if (response.status === 401) {
    invalidateAccountCache();
    await clearOfflineAccountGrant(cookie);
    if (authClient.getCookie() === cookie) locallySignedOutCookie = cookie;
    if (route === '/api/agent')
      throw new Error(
        'Please sign in to ScholarOS again to refresh academic data.',
      );
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

export const isAccountSessionCurrent = (cookie: string) => {
  try {
    return (
      !!cookie.trim() &&
      cookie !== locallySignedOutCookie &&
      cookie === authClient.getCookie()
    );
  } catch {
    return false;
  }
};

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
  let result: Awaited<ReturnType<typeof accountRequest>>;
  try {
    result = await accountRequest('/api/me');
  } catch (error) {
    if (!(error instanceof Error) || error.cause === undefined) throw error;
    const offlineUser = await readOfflineAccountGrant(cookie);
    if (offlineUser && epoch === cacheEpoch && isAccountSessionCurrent(cookie))
      return offlineUser;
    throw error;
  }
  const currentCookie = authClient.getCookie();
  if (!currentCookie.trim() || locallySignedOutCookie === cookie) return null;
  if (currentCookie !== cookie)
    throw new Error('Your session changed; please try again.');
  if (!result?.user?.id) {
    await clearOfflineAccountGrant(cookie);
    return null;
  }
  if (epoch !== cacheEpoch)
    throw new Error('Your session changed; please try again.');
  const user: CurrentUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    image: typeof result.user.image === 'string' ? result.user.image : null,
    hasCompletedOnboarding: result.user.hasCompletedOnboarding === true,
  };
  await saveOfflineAccountGrant(user, cookie).catch(() => false);
  if (epoch !== cacheEpoch || !isAccountSessionCurrent(cookie)) {
    await clearOfflineAccountGrant(cookie);
    throw new Error('Your session changed; please try again.');
  }
  cachedAccount = { cookie, user, expiresAt: Date.now() + 30_000 };
  return user;
};
