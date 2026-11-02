import { createHash } from 'node:crypto';
import {
  browserNavigationCapabilitySchema,
  type BrowserNavigationMode,
} from '@scholaros/env/browser-navigation';
import { authClient } from '../../../lib/auth/client';
import {
  accountRequest,
  isAccountSessionCurrent,
} from '../../../lib/auth/main';

type BrowserNavigationModeOptions = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

const sessionModeCache = new Map<string, BrowserNavigationMode>();

const getSessionKey = (cookie: string) =>
  createHash('sha256').update(cookie).digest('hex');

export const clearBrowserNavigationModeCache = () => {
  sessionModeCache.clear();
};

export const getBrowserNavigationMode = async (
  options: BrowserNavigationModeOptions,
): Promise<BrowserNavigationMode> => {
  options.signal.throwIfAborted();
  const cookie = authClient.getCookie();
  if (!cookie.trim() || !isAccountSessionCurrent(cookie))
    throw new Error('Sign in before starting academic browser work.');
  const sessionKey = getSessionKey(cookie);
  const cachedMode = sessionModeCache.get(sessionKey);
  if (cachedMode) {
    if (!options.isCurrent() || !isAccountSessionCurrent(cookie))
      throw new Error('Your session changed before browser work could start.');
    return cachedMode;
  }

  const capability = await accountRequest(
    '/api/agent',
    undefined,
    options.signal,
  );
  options.signal.throwIfAborted();
  if (!options.isCurrent() || !isAccountSessionCurrent(cookie))
    throw new Error('Your session changed while loading browser mode.');
  const parsed = browserNavigationCapabilitySchema.safeParse(capability);
  if (!parsed.success)
    throw new Error('The server returned an invalid browser mode capability.');
  sessionModeCache.set(sessionKey, parsed.data.browserNavigationMode);
  return parsed.data.browserNavigationMode;
};
