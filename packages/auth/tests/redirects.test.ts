import { expect, test } from 'vitest';
import {
  getAuthRedirect,
  getAuthPageHref,
  getDesktopAuthQuery,
  localReturnPath,
} from '../src/redirects';

const query = new URLSearchParams({
  client_id: 'electron',
  state: 'a'.repeat(16),
  code_challenge: 'b'.repeat(43),
  redirect: '/courses?week=2',
});

test('web return paths reject external URLs, encoded escapes, and auth loops', () => {
  for (const value of [
    null,
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/%5cevil.example',
    '/%2fevil.example',
    '/sign-in',
    '/sign-up',
    '/auth/desktop',
  ]) {
    expect(localReturnPath(value)).toBe('/');
  }
  expect(localReturnPath('/courses?week=2#biology')).toBe(
    '/courses?week=2#biology',
  );
  expect(getAuthRedirect(new URLSearchParams('redirect=/courses'))).toBe(
    '/courses',
  );
});

test('desktop handshakes are validated and preserved through auth page switches', () => {
  expect(getDesktopAuthQuery(query)).toEqual({
    client_id: 'electron',
    state: 'a'.repeat(16),
    code_challenge: 'b'.repeat(43),
  });
  const next = new URL(getAuthRedirect(query), 'https://scholaros.example');
  expect(next.pathname).toBe('/auth/desktop');
  expect(next.searchParams.get('state')).toBe(query.get('state'));
  const signup = new URL(
    getAuthPageHref('/sign-up', query),
    'https://scholaros.example',
  );
  expect(signup.pathname).toBe('/sign-up');
  expect(getDesktopAuthQuery(signup.searchParams)).toEqual(
    getDesktopAuthQuery(query),
  );
  expect(signup.searchParams.get('redirect')).toBe('/courses?week=2');
  for (const key of ['client_id', 'state', 'code_challenge']) {
    const invalid = new URLSearchParams(query);
    invalid.delete(key);
    expect(getDesktopAuthQuery(invalid)).toBeNull();
  }
  expect(
    getDesktopAuthQuery(
      new URLSearchParams('client_id=other&state=short&code_challenge=short'),
    ),
  ).toBeNull();
});
