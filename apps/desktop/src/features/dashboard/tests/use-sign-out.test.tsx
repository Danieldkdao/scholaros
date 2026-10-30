// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSignOut } from '../hooks/use-sign-out';
import type { SignOutDependencies } from '../../../lib/session-actions';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const Harness = ({ dependencies }: { dependencies: SignOutDependencies }) => {
  const { signingOut, error, signOutNow } = useSignOut(dependencies);
  return createElement(
    'div',
    null,
    createElement(
      'button',
      {
        id: 'sign-out',
        disabled: signingOut,
        onClick: () => void signOutNow(),
      },
      'Log out',
    ),
    createElement('span', { id: 'signing-out' }, String(signingOut)),
    createElement('span', { id: 'error' }, error ?? ''),
  );
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = async (dependencies: SignOutDependencies) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { dependencies }));
  });
};

const text = (id: string) => container.querySelector(`#${id}`)?.textContent;

const signOutButton = () =>
  container.querySelector<HTMLButtonElement>('#sign-out')!;

const clickSignOut = async () => {
  await act(async () => {
    signOutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

let steps: string[];
let dependencies: SignOutDependencies;

beforeEach(() => {
  vi.resetAllMocks();
  steps = [];
  dependencies = {
    signOut: vi.fn(async () => {
      steps.push('sign-out');
    }),
    clearRendererState: vi.fn(() => {
      steps.push('clear');
    }),
    navigateToAuth: vi.fn(async () => {
      steps.push('navigate');
    }),
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('sign out', () => {
  it('clears renderer state and returns to authentication in order', async () => {
    await mount(dependencies);
    await clickSignOut();
    expect(steps).toEqual(['sign-out', 'clear', 'navigate']);
    expect(text('signing-out')).toBe('false');
    expect(text('error')).toBe('');
  });

  it('never asks the main process to quit', async () => {
    const quit = vi.fn();
    (window as { scholar?: { quit?: () => void } }).scholar = { quit };
    await mount(dependencies);
    await clickSignOut();
    expect(quit).not.toHaveBeenCalled();
  });

  it('disables the action while signing out', async () => {
    const pending = deferred();
    dependencies.signOut = vi.fn(() => pending.promise);
    await mount(dependencies);
    await clickSignOut();
    expect(signOutButton().disabled).toBe(true);
    expect(text('signing-out')).toBe('true');
    pending.resolve();
    await act(async () => undefined);
    expect(text('signing-out')).toBe('false');
  });

  it('ignores a second request while the first is still running', async () => {
    const pending = deferred();
    dependencies.signOut = vi.fn(() => pending.promise);
    await mount(dependencies);
    await clickSignOut();
    signOutButton().disabled = false;
    await clickSignOut();
    await clickSignOut();
    pending.resolve();
    await act(async () => undefined);
    expect(dependencies.signOut).toHaveBeenCalledOnce();
    expect(dependencies.navigateToAuth).toHaveBeenCalledOnce();
  });

  it('reports a failure and stays recoverable', async () => {
    dependencies.signOut = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network unreachable'))
      .mockImplementationOnce(async () => {
        steps.push('sign-out');
      });
    await mount(dependencies);
    await clickSignOut();
    expect(text('error')).toBe('Network unreachable');
    expect(text('signing-out')).toBe('false');
    expect(signOutButton().disabled).toBe(false);
    expect(dependencies.clearRendererState).not.toHaveBeenCalled();
    await clickSignOut();
    expect(steps).toEqual(['sign-out', 'clear', 'navigate']);
    expect(text('error')).toBe('');
  });

  it('explains a failure that carries no message', async () => {
    dependencies.signOut = vi.fn().mockRejectedValueOnce(undefined);
    await mount(dependencies);
    await clickSignOut();
    expect(text('error')).toBe('Could not sign out. Please try again.');
  });
});
