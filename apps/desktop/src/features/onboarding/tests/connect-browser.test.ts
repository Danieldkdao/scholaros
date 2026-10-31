import { expect, it, vi } from 'vitest';
import { createConnectBrowser } from '../services/connect-browser';
const candidate = {
  name: 'School',
  url: 'https://school.edu/',
  provider: 'unknown' as const,
};
it('captures only through the protected page after confirming the approved host', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(async () => 'https://school.edu/'),
    evaluate: vi.fn(async () => ({
      host: 'school.edu',
      pathname: '/',
      hasPasswordField: false,
    })),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const capture = vi.fn(async () => undefined);
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async () => guard,
    capture,
  });
  const signal = new AbortController().signal;
  expect(await browser.inspect(candidate, signal)).toEqual({
    status: 'readable',
    host: 'school.edu',
  });
  await browser.capture(candidate, signal);
  expect(capture).toHaveBeenCalledWith(
    page,
    'school.edu',
    signal,
    guard.assertReadable,
  );
  expect(guard.assertReadable).toHaveBeenCalled();
  expect(guard).toHaveBeenCalled();
});
it('never captures an unapproved redirect or a password field', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(async () => 'https://school.edu/'),
    evaluate: vi.fn(async () => ({
      host: 'other.edu',
      pathname: '/',
      hasPasswordField: true,
    })),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const capture = vi.fn();
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async () => guard,
    capture,
  });
  expect(
    (await browser.inspect(candidate, new AbortController().signal)).status,
  ).toBe('blocked');
  expect(capture).not.toHaveBeenCalled();
  expect(guard).toHaveBeenCalled();
});

it('closes its protected tab promptly when cancellation occurs during navigation', async () => {
  let rejectNavigation!: (error: Error) => void;
  const page = {
    goto: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectNavigation = reject;
        }),
    ),
    close: vi.fn(async () => {
      rejectNavigation(new Error('closed'));
    }),
  };
  const guard = Object.assign(
    vi.fn(async () => {
      await page.close();
    }),
    { assertReadable: vi.fn() },
  );
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async () => guard,
    capture: vi.fn(),
  });
  const controller = new AbortController();
  const pending = browser.inspect(candidate, controller.signal);
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalled());
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(page.close).toHaveBeenCalled();
});

it('reports a protected sign-in redirect without opening it or capturing', async () => {
  const page = {
    goto: vi.fn(async () => {
      throw new Error('blocked');
    }),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const capture = vi.fn();
  const protect = vi.fn(
    async (_page, _host, onSignIn: (host: string) => void) => {
      onSignIn('accounts.google.com');
      return guard;
    },
  );
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect,
    capture,
  });
  expect(
    await browser.inspect(candidate, new AbortController().signal),
  ).toEqual({ status: 'sign-in', host: 'accounts.google.com' });
  expect(capture).not.toHaveBeenCalled();
  expect(page.goto).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledOnce();
});

it('hands off immediately when the guard blocks a sign-in redirect', async () => {
  let notifySignIn!: (host: string) => void;
  const page = {
    goto: vi.fn(() => new Promise(() => {})),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async (_page, _host, callback) => {
      notifySignIn = callback;
      return guard;
    },
    capture: vi.fn(),
  });
  const pending = browser.inspect(candidate, new AbortController().signal);
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalled());
  notifySignIn('accounts.google.com');
  await expect(
    Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 100)),
    ]),
  ).resolves.toEqual({ status: 'sign-in', host: 'accounts.google.com' });
  expect(guard).toHaveBeenCalledOnce();
});

it('hands a visible sign-in form on the approved site to the student', async () => {
  const page = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(async () => candidate.url),
    evaluate: vi.fn(async () => ({
      host: 'school.edu',
      pathname: '/',
      hasPasswordField: true,
    })),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async () => guard,
    capture: vi.fn(),
  });
  expect(
    await browser.inspect(candidate, new AbortController().signal),
  ).toEqual({ status: 'sign-in', host: 'school.edu' });
  await browser.close();
});

it('offers the approved site for manual recovery when browser policy blocks a redirect before interception', async () => {
  const page = {
    goto: vi.fn(async () => {
      throw new Error('Blocked by browser policy');
    }),
    close: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const browser = createConnectBrowser({
    createPage: async () => page as never,
    protect: async () => guard,
    capture: vi.fn(),
  });
  expect(
    await browser.inspect(candidate, new AbortController().signal),
  ).toEqual({ status: 'sign-in', host: 'school.edu' });
  expect(guard).toHaveBeenCalledOnce();
});
