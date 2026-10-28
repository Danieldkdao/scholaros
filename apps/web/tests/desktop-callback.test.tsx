// @vitest-environment jsdom
import * as React from 'react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DesktopCallback } from '../src/components/auth/desktop-callback';

const state = vi.hoisted(() => ({
  query:
    'client_id=electron&state=aaaaaaaaaaaaaaaa&code_challenge=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  getSession: vi.fn(),
  getAuthorizationCode: vi.fn(),
  transferUser: vi.fn(),
  open: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock('@scholaros/auth/client', () => ({
  authClient: {
    getSession: state.getSession,
    electron: {
      transferUser: state.transferUser,
      getAuthorizationCode: state.getAuthorizationCode,
    },
    ensureElectronRedirect: state.open,
  },
}));
vi.mock('@scholaros/ui/components/button', () => ({
  Button: (props: React.ComponentProps<'button'>) =>
    React.createElement('button', props),
}));
vi.mock('@scholaros/ui/components/card', () => ({
  Card: (props: React.ComponentProps<'div'>) =>
    React.createElement('div', props),
  CardContent: (props: React.ComponentProps<'div'>) =>
    React.createElement('div', props),
}));
vi.mock('@scholaros/ui/components/loading-swap', () => ({
  LoadingSwap: ({
    children,
    isLoading,
  }: {
    children: React.ReactNode;
    isLoading: boolean;
  }) => (isLoading ? 'Loading' : children),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  sessionStorage.clear();
  state.query =
    'client_id=electron&state=aaaaaaaaaaaaaaaa&code_challenge=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  state.getAuthorizationCode.mockReturnValue('synthetic');
  state.getSession.mockResolvedValue({
    data: { user: { emailVerified: true } },
  });
  state.transferUser.mockResolvedValue({
    data: { electron_authorization_code: 'synthetic' },
  });
  state.open.mockImplementation(() => {
    state.getAuthorizationCode.mockReturnValue(null);
    return 123;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('Strict Mode transfers once, then opens the app only from the stable completion URL', async () => {
  const view = render(
    <StrictMode>
      <DesktopCallback />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(state.replace).toHaveBeenCalledWith('/auth/desktop?completed=1'),
  );
  expect(state.getSession).toHaveBeenCalledTimes(1);
  expect(state.transferUser).toHaveBeenCalledTimes(1);
  expect(state.open).not.toHaveBeenCalled();
  state.query = 'completed=1';
  view.rerender(
    <StrictMode>
      <DesktopCallback />
    </StrictMode>,
  );
  await waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
  view.rerender(
    <StrictMode>
      <DesktopCallback />
    </StrictMode>,
  );
  expect(state.open).toHaveBeenCalledTimes(1);
});

test('refreshing the completed URL neither fetches sessions nor repeats a consumed handoff', async () => {
  state.query = 'completed=1';
  const first = render(<DesktopCallback />);
  await waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
  first.unmount();
  vi.clearAllMocks();
  render(<DesktopCallback />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('close this tab'),
  );
  expect(state.getSession).not.toHaveBeenCalled();
  expect(state.transferUser).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
});

test('a saved dispatched flag cannot block a new sign-in', async () => {
  sessionStorage.setItem(
    `scholaros:desktop-handoff:${state.query}`,
    'dispatched',
  );
  render(<DesktopCallback />);
  await waitFor(() => expect(state.transferUser).toHaveBeenCalledTimes(1));
  expect(state.replace).toHaveBeenCalledWith('/auth/desktop?completed=1');
});

test('an expired session returns to sign-in once without transferring or opening the app', async () => {
  state.getSession.mockResolvedValue({ data: null });
  const view = render(
    <StrictMode>
      <DesktopCallback />
    </StrictMode>,
  );
  await waitFor(() => expect(state.replace).toHaveBeenCalledTimes(1));
  expect(state.replace.mock.calls[0][0]).toMatch(/^\/sign-in\?/);
  view.rerender(
    <StrictMode>
      <DesktopCallback />
    </StrictMode>,
  );
  expect(state.replace).toHaveBeenCalledTimes(1);
  expect(state.transferUser).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
});
