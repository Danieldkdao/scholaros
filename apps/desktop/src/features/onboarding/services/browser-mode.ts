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

export const invalidateBrowserNavigationMode = () => {
  sessionModeCache.clear();
};

export class BrowserCapabilityChangedError extends Error {
  readonly code = 'capability-changed';

  constructor() {
    super(
      'The server-selected browser mode changed. Start a new academic task to continue.',
    );
    this.name = 'BrowserCapabilityChangedError';
    invalidateBrowserNavigationMode();
  }
}

export const toBrowserCapabilityError = (error: unknown) => {
  if (error instanceof BrowserCapabilityChangedError) return error;
  if (error instanceof Error && error.message === 'capability-changed')
    return new BrowserCapabilityChangedError();
  return error;
};

const getSessionKey = (cookie: string) =>
  createHash('sha256').update(cookie).digest('hex');

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

  let capability: unknown;
  try {
    capability = await accountRequest('/api/agent', undefined, options.signal);
  } catch (error) {
    throw toBrowserCapabilityError(error);
  }
  options.signal.throwIfAborted();
  if (!options.isCurrent() || !isAccountSessionCurrent(cookie))
    throw new Error('Your session changed while loading browser mode.');
  const parsed = browserNavigationCapabilitySchema.safeParse(capability);
  if (!parsed.success)
    throw new Error('The server returned an invalid browser mode capability.');
  sessionModeCache.set(sessionKey, parsed.data.browserNavigationMode);
  return parsed.data.browserNavigationMode;
};
