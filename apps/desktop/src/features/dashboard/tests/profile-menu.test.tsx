// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../../../lib/auth/helpers';
import type { CurrentUser } from '../../onboarding/types';

const routerMocks = vi.hoisted(() => ({
  invalidate: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => routerMocks,
  Link: ({ to, ...props }: Record<string, unknown>) =>
    createElement('a', { ...props, href: `#${String(to)}` } as never),
}));

vi.mock('../../../lib/auth/helpers', () => ({ getCurrentUser: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { ProfileMenu } = await import('../profile-menu');
const { SidebarProvider } = await import('@scholaros/ui/components/sidebar');

const account = (changes: Partial<CurrentUser> = {}): CurrentUser => ({
  id: 'student-a',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  image: null,
  hasCompletedOnboarding: true,
  ...changes,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const bridge = {
  signOut: vi.fn(async () => undefined),
} as unknown as typeof window.scholar;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(SidebarProvider, null, createElement(ProfileMenu)),
    );
  });
};

const trigger = () => container.querySelector('button') as HTMLElement | null;

const openMenu = async () => {
  await act(async () => {
    for (const type of [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ])
      trigger()!.dispatchEvent(
        type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true })
          : new MouseEvent(type, { bubbles: true }),
      );
  });
};

const popup = () =>
  document.body.querySelector('[data-slot="dropdown-menu-content"]');

const menuItem = (label: string) =>
  [
    ...(popup()?.querySelectorAll('[data-slot="dropdown-menu-item"]') ?? []),
  ].find((item) => item.textContent?.includes(label));

const clickItem = async (label: string) => {
  const item = menuItem(label);
  expect(item, `missing a "${label}" menu item`).toBeTruthy();
  await act(async () => {
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const installDomStubs = () => {
  globalThis.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
};

beforeEach(() => {
  vi.resetAllMocks();
  installDomStubs();
  vi.mocked(getCurrentUser).mockResolvedValue(account());
  bridge.signOut = vi.fn(async () => undefined);
  window.scholar = bridge;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('profile trigger', () => {
  it('shows the signed-in name and email', async () => {
    await mount();
    expect(trigger()!.textContent).toContain('Ada Lovelace');
    expect(trigger()!.textContent).toContain('ada@example.edu');
  });

  it('falls back to the email when the account has no name', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(account({ name: '   ' }));
    await mount();
    expect(trigger()!.textContent).toContain('ada@example.edu');
  });

  it('falls back to the account initials when there is no photo', async () => {
    await mount();
    expect(trigger()!.textContent).toContain('AL');
  });

  it('does not invent a profile while the account is loading', async () => {
    const pending = deferred<CurrentUser | null>();
    vi.mocked(getCurrentUser).mockReturnValueOnce(pending.promise);
    await mount();
    expect(trigger()).toBeNull();
    pending.resolve(account());
    await act(async () => undefined);
    expect(trigger()!.textContent).toContain('Ada Lovelace');
  });
});

describe('profile menu', () => {
  it('repeats the full name and email inside the menu', async () => {
    await mount();
    await openMenu();
    expect(popup()?.textContent).toContain('Ada Lovelace');
    expect(popup()?.textContent).toContain('ada@example.edu');
  });

  it('links Settings to the settings page', async () => {
    await mount();
    await openMenu();
    expect(menuItem('Settings')?.getAttribute('href')).toBe(
      '#/dashboard/settings',
    );
  });

  it('marks Log out as destructive', async () => {
    await mount();
    await openMenu();
    expect(menuItem('Log out')?.getAttribute('data-variant')).toBe(
      'destructive',
    );
  });

  it('does not offer a second sign-out control in the sidebar', async () => {
    await mount();
    expect(container.textContent).not.toContain('Exit and sign out');
  });

  it('signs out through the bridge and returns to authentication', async () => {
    await mount();
    await openMenu();
    await clickItem('Log out');
    expect(bridge.signOut).toHaveBeenCalledOnce();
    expect(routerMocks.invalidate).toHaveBeenCalledOnce();
    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: '/auth' });
  });

  it('clears the signed-in profile as part of signing out', async () => {
    await mount();
    await openMenu();
    expect(document.body.textContent).toContain('Ada Lovelace');
    await clickItem('Log out');
    expect(bridge.signOut).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Ada Lovelace');
  });

  it('reports a failed sign out and allows another attempt', async () => {
    bridge.signOut = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network unreachable'));
    await mount();
    await openMenu();
    await clickItem('Log out');
    expect(document.body.textContent).toContain('Network unreachable');
    expect(routerMocks.navigate).not.toHaveBeenCalled();
    await clickItem('Log out');
    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: '/auth' });
  });

  it('does not ask for confirmation before signing out', async () => {
    await mount();
    await openMenu();
    expect(
      document.body.querySelector('[data-slot="alert-dialog-content"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Are you sure');
  });
});
