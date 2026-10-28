import { desktopCallbackPath, desktopClientId } from './constants';
import type { DesktopAuthQuery } from './types';

type AuthParams = Pick<URLSearchParams, 'get'>;

export const localReturnPath = (value?: string | null) => {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://scholaros.invalid');
    let path = url.pathname;
    for (let index = 0; index < 3; index++) path = decodeURIComponent(path);
    if (
      url.origin !== 'https://scholaros.invalid' ||
      path.startsWith('//') ||
      path.includes('\\') ||
      Array.from(path).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return '/';
    if (
      ['/sign-in', '/sign-up', desktopCallbackPath].includes(
        path.replace(/\/$/, ''),
      )
    )
      return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
};

export const getDesktopAuthQuery = (
  params: AuthParams,
): DesktopAuthQuery | null => {
  const client_id = params.get('client_id');
  const state = params.get('state');
  const code_challenge = params.get('code_challenge');
  if (
    client_id !== desktopClientId ||
    !state ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    !code_challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(code_challenge)
  )
    return null;
  return { client_id, state, code_challenge };
};

export const getAuthRedirect = (params: AuthParams) => {
  const desktop = getDesktopAuthQuery(params);
  return desktop
    ? `${desktopCallbackPath}?${new URLSearchParams(desktop)}`
    : localReturnPath(params.get('redirect'));
};

export const getAuthPageHref = (
  path: '/sign-in' | '/sign-up',
  params: AuthParams,
) => {
  const query = new URLSearchParams(getDesktopAuthQuery(params) ?? {});
  query.set('redirect', localReturnPath(params.get('redirect')));
  return `${path}?${query}`;
};
