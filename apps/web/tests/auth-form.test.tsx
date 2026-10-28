// @vitest-environment jsdom
import * as React from 'react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuthForm } from '../src/components/auth/auth-form';

const state = vi.hoisted(() => ({
  query: '',
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock('@scholaros/auth/client', () => ({
  authClient: {
    useSession: () => ({
      data: { user: { emailVerified: true } },
      isPending: false,
    }),
  },
}));
vi.mock('@scholaros/ui/components/toast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('../src/components/auth/verify-account', () => ({
  VerifyAccount: () => null,
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a cached browser session does not redirect a fresh desktop sign-in', () => {
  state.query =
    'client_id=electron&state=aaaaaaaaaaaaaaaa&code_challenge=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const view = render(
    <StrictMode>
      <AuthForm />
    </StrictMode>,
  );
  expect(
    screen.getByRole('button', { name: 'Continue with Google' }),
  ).toBeDefined();
  view.rerender(
    <StrictMode>
      <AuthForm />
    </StrictMode>,
  );
  expect(state.replace).not.toHaveBeenCalled();
});

test('ordinary web sign-in still redirects an authenticated browser user', () => {
  state.query = '';
  render(<AuthForm />);
  expect(state.replace).toHaveBeenCalledWith('/');
});
