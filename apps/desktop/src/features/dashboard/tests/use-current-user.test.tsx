// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../../../lib/auth/helpers';
import { useCurrentUser } from '../hooks/use-current-user';
import type { CurrentUser } from '../../onboarding/types';

vi.mock('../../../lib/auth/helpers', () => ({ getCurrentUser: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const account: CurrentUser = {
  id: 'student-a',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  image: null,
  hasCompletedOnboarding: true,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const Harness = () => {
  const { user, loading, error, clear, reload } = useCurrentUser();
  return createElement(
    'div',
    null,
    createElement('span', { id: 'name' }, user?.name ?? ''),
    createElement('span', { id: 'email' }, user?.email ?? ''),
    createElement('span', { id: 'loading' }, String(loading)),
    createElement('span', { id: 'error' }, error ?? ''),
    createElement('button', { id: 'clear', onClick: clear }, 'clear'),
    createElement(
      'button',
      { id: 'reload', onClick: () => void reload() },
      'reload',
    ),
  );
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness));
  });
};

const text = (id: string) => container.querySelector(`#${id}`)?.textContent;

const click = async (id: string) => {
  await act(async () => {
    container
      .querySelector(`#${id}`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(account);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('account loading', () => {
  it('shows the signed-in account', async () => {
    await mount();
    expect(text('name')).toBe('Ada Lovelace');
    expect(text('email')).toBe('ada@example.edu');
    expect(text('loading')).toBe('false');
  });

  it('reports a failed load without inventing profile information', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('Account offline'));
    await mount();
    expect(text('name')).toBe('');
    expect(text('error')).toBe('Account offline');
    expect(text('loading')).toBe('false');
  });

  it('loads the account again on request', async () => {
    const pending = deferred<CurrentUser | null>();
    vi.mocked(getCurrentUser).mockReturnValueOnce(pending.promise);
    await mount();
    expect(text('loading')).toBe('true');
    pending.resolve(account);
    await act(async () => undefined);
    expect(text('name')).toBe('Ada Lovelace');
    vi.mocked(getCurrentUser).mockClear();
    await click('reload');
    expect(getCurrentUser).toHaveBeenCalledOnce();
  });
});

describe('stale account responses', () => {
  it('ignores a response that resolves after the account was cleared', async () => {
    const pending = deferred<CurrentUser | null>();
    vi.mocked(getCurrentUser).mockReturnValueOnce(pending.promise);
    await mount();
    await click('clear');
    expect(text('name')).toBe('');
    expect(text('loading')).toBe('false');
    pending.resolve(account);
    await act(async () => undefined);
    expect(text('name')).toBe('');
  });

  it('ignores a response that resolves after the shell unmounted', async () => {
    const pending = deferred<CurrentUser | null>();
    vi.mocked(getCurrentUser).mockReturnValueOnce(pending.promise);
    await mount();
    act(() => root?.unmount());
    root = undefined;
    expect(() => pending.resolve(account)).not.toThrow();
    await act(async () => undefined);
    expect(document.body.textContent).toBe('');
  });

  it('does not repaint a cleared account when a retry was already started', async () => {
    const first = deferred<CurrentUser | null>();
    const second = deferred<CurrentUser | null>();
    vi.mocked(getCurrentUser)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount();
    await click('reload');
    first.resolve(account);
    await act(async () => undefined);
    expect(text('name')).toBe('');
    second.resolve(account);
    await act(async () => undefined);
    expect(text('name')).toBe('Ada Lovelace');
  });
});
