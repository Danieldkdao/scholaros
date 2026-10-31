import { expect, it, vi } from 'vitest';
import { createConnectWorkspace } from '../services/connect-workspace';

it('sets the approved host policy and protects every automated page', async () => {
  const manualPage = {
    close: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
  };
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
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi
      .fn()
      .mockResolvedValueOnce(manualPage)
      .mockResolvedValueOnce(page),
    setActivePage: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const protect = vi.fn(async () => guard);
  const capture = vi.fn(async () => undefined);
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect,
    terminateWorkspace: vi.fn(async () => undefined),
    capture,
  });
  expect(context.setDomainPolicy).toHaveBeenCalledWith({
    allowedDomains: ['school.edu'],
    blockedDomains: [],
  });
  const candidate = {
    name: 'School',
    url: 'https://school.edu/',
    provider: 'unknown' as const,
  };
  const signal = new AbortController().signal;
  await workspace.prepareHandoff('https://school.edu/', signal);
  expect(manualPage.goto).toHaveBeenCalledWith('https://school.edu/', {
    timeout: 20_000,
  });
  expect(context.setDomainPolicy).toHaveBeenLastCalledWith(null);
  await workspace.inspect(candidate, signal);
  await workspace.capture(candidate, signal);
  expect(protect).toHaveBeenCalledWith(
    page,
    'http://127.0.0.1:1',
    ['school.edu'],
    expect.any(Function),
  );
  await workspace.close();
  expect(context.setDomainPolicy).toHaveBeenLastCalledWith(null);
  expect(manualPage.close).toHaveBeenCalled();
});

it('blocks a sign-in redirect until the user resumes, then captures the approved site', async () => {
  const manualPage = {
    close: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
  };
  const blockedPage = {
    goto: vi.fn(async () => {
      throw new Error('blocked');
    }),
    close: vi.fn(async () => undefined),
  };
  const readyPage = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(async () => 'https://school.edu/'),
    evaluate: vi.fn(async () => ({
      host: 'school.edu',
      pathname: '/',
      hasPasswordField: false,
    })),
    close: vi.fn(async () => undefined),
  };
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi
      .fn()
      .mockResolvedValueOnce(blockedPage)
      .mockResolvedValueOnce(manualPage)
      .mockResolvedValueOnce(readyPage),
    setActivePage: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const protect = vi.fn(async (page, _cdp, _hosts, onBlocked) => {
    if (page === blockedPage)
      onBlocked({
        host: 'login.school.edu',
        resourceType: 'Document',
        signInWall: true,
      });
    return guard;
  });
  const capture = vi.fn(async () => undefined);
  const browser = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: protect as never,
    terminateWorkspace: vi.fn(async () => undefined),
    capture,
  });
  const { createConnectRun } = await import('../services/connect-run');
  const run = createConnectRun(browser);
  const completion = run.start('student', [
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  await vi.waitFor(() =>
    expect(run.getState('student').status).toBe('awaiting-user'),
  );
  expect(capture).not.toHaveBeenCalled();
  expect(readyPage.goto).not.toHaveBeenCalled();
  run.resume('student');
  await completion;
  expect(capture).toHaveBeenCalledOnce();
  expect(run.getState('student').results).toEqual([
    { host: 'school.edu', status: 'connected' },
  ]);
  await browser.close();
});

it('closes the student tab and restores policy even if protected-page cleanup fails', async () => {
  const manualPage = {
    close: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
  };
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
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi
      .fn()
      .mockResolvedValueOnce(manualPage)
      .mockResolvedValueOnce(page),
    setActivePage: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => {
      throw new Error('failed');
    }),
    { assertReadable: vi.fn() },
  );
  const terminateWorkspace = vi.fn(async () => undefined);
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(async () => guard),
    terminateWorkspace,
    capture: vi.fn(async () => undefined),
  });
  await workspace.prepareHandoff(
    'https://school.edu/',
    new AbortController().signal,
  );
  await workspace.inspect(
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    new AbortController().signal,
  );
  await expect(workspace.close()).rejects.toThrow();
  expect(manualPage.close).toHaveBeenCalledOnce();
  expect(terminateWorkspace).toHaveBeenCalledOnce();
});

it('closes the workspace instead of dropping the policy if the student tab cannot close', async () => {
  const manualPage = {
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      throw new Error('cannot close');
    }),
  };
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn(async () => manualPage),
    setActivePage: vi.fn(async () => undefined),
  };
  const terminateWorkspace = vi.fn(async () => undefined);
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(),
    capture: vi.fn(),
    terminateWorkspace,
  });
  await workspace.prepareHandoff(
    'https://school.edu/',
    new AbortController().signal,
  );
  await expect(workspace.close()).rejects.toThrow();
  expect(terminateWorkspace).toHaveBeenCalledOnce();
  expect(terminateWorkspace).toHaveBeenCalledOnce();
});

it('closes every new popup before clearing the run policy and preserves existing tabs', async () => {
  const existing = { pageId: 'old', close: vi.fn(async () => undefined) };
  const manual = {
    pageId: 'manual',
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const popup = { pageId: 'popup', close: vi.fn(async () => undefined) };
  const context = {
    pages: vi
      .fn()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing, manual, popup])
      .mockResolvedValue([existing]),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn(async () => manual),
    setActivePage: vi.fn(async () => undefined),
  };
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(),
    capture: vi.fn(),
    terminateWorkspace: vi.fn(async () => undefined),
  });
  await workspace.prepareHandoff(
    'https://school.edu/',
    new AbortController().signal,
  );
  await workspace.close();
  expect(popup.close).toHaveBeenCalledOnce();
  expect(existing.close).not.toHaveBeenCalled();
  expect(context.setDomainPolicy).toHaveBeenLastCalledWith(null);
});

it('hands off an unfamiliar public redirect without configured sign-in hosts', async () => {
  const page = {
    pageId: 'page',
    goto: vi.fn(async () => {
      throw new Error('blocked');
    }),
    close: vi.fn(async () => undefined),
  };
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn().mockResolvedValueOnce(page),
    setActivePage: vi.fn(async () => undefined),
  };
  const guard = Object.assign(
    vi.fn(async () => undefined),
    { assertReadable: vi.fn() },
  );
  const protect = vi.fn(async (_page, _cdp, _hosts, blocked) => {
    blocked({
      host: 'identity.example.edu',
      resourceType: 'Document',
      signInWall: false,
      mainFrame: true,
    });
    return guard;
  });
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: protect as never,
    capture: vi.fn(),
    terminateWorkspace: vi.fn(async () => undefined),
  });
  expect(
    await workspace.inspect(
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      new AbortController().signal,
    ),
  ).toEqual({ status: 'sign-in', host: 'identity.example.edu' });
  await workspace.close();
});

it('closes the workspace if applying the host policy fails partway through', async () => {
  const context = {
    pages: vi.fn(async () => []),
    setDomainPolicy: vi.fn(async () => {
      throw new Error('policy failed');
    }),
    newPage: vi.fn(),
    setActivePage: vi.fn(),
  };
  const terminateWorkspace = vi.fn(async () => undefined);
  await expect(
    createConnectWorkspace({
      context: context as never,
      cdpUrl: 'http://127.0.0.1:1',
      accountId: 'student',
      sites: {
        candidates: [
          { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
        ],
      },
      protect: vi.fn(),
      capture: vi.fn(),
      terminateWorkspace,
    }),
  ).rejects.toThrow('policy failed');
  expect(terminateWorkspace).toHaveBeenCalledOnce();
  expect(context.newPage).not.toHaveBeenCalled();
});

it('closes popups spawned while run-owned tabs are being closed before releasing the policy', async () => {
  const manual = {
    pageId: 'manual',
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const first = { pageId: 'first', close: vi.fn(async () => undefined) };
  const second = { pageId: 'second', close: vi.fn(async () => undefined) };
  const context = {
    pages: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValue([]),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn(async () => manual),
    setActivePage: vi.fn(async () => undefined),
  };
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(),
    capture: vi.fn(),
    terminateWorkspace: vi.fn(async () => undefined),
  });
  await workspace.close();
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

it('keeps closing the remaining tabs when one already closed tab rejects', async () => {
  const existing = { pageId: 'old', close: vi.fn(async () => undefined) };
  const manual = {
    pageId: 'manual',
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const gone = {
    pageId: 'gone',
    close: vi.fn(async () => {
      throw new Error('Cannot read properties of null (reading close)');
    }),
  };
  const alive = { pageId: 'alive', close: vi.fn(async () => undefined) };
  const context = {
    pages: vi
      .fn()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing, manual, gone, alive])
      .mockResolvedValue([existing]),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn(async () => manual),
    setActivePage: vi.fn(async () => undefined),
  };
  const terminateWorkspace = vi.fn(async () => undefined);
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(),
    capture: vi.fn(),
    terminateWorkspace,
  });
  await workspace.prepareHandoff(
    'https://school.edu/',
    new AbortController().signal,
  );
  await expect(workspace.close()).resolves.toBeUndefined();
  expect(alive.close).toHaveBeenCalledOnce();
  expect(existing.close).not.toHaveBeenCalled();
  expect(terminateWorkspace).not.toHaveBeenCalled();
  expect(context.setDomainPolicy).toHaveBeenLastCalledWith(null);
});

it('still closes the workspace when a run-owned tab survives every attempt', async () => {
  const manual = {
    pageId: 'manual',
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const stubborn = {
    pageId: 'stubborn',
    close: vi.fn(async () => {
      throw new Error('Target closed');
    }),
  };
  const context = {
    pages: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([stubborn]),
    setDomainPolicy: vi.fn(async () => undefined),
    newPage: vi.fn(async () => manual),
    setActivePage: vi.fn(async () => undefined),
  };
  const terminateWorkspace = vi.fn(async () => undefined);
  const workspace = await createConnectWorkspace({
    context: context as never,
    cdpUrl: 'http://127.0.0.1:1',
    accountId: 'student',
    sites: {
      candidates: [
        { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
      ],
    },
    protect: vi.fn(),
    capture: vi.fn(),
    terminateWorkspace,
  });
  await workspace.prepareHandoff(
    'https://school.edu/',
    new AbortController().signal,
  );
  await expect(workspace.close()).rejects.toThrow(
    'Could not close connection tabs.',
  );
  expect(stubborn.close).toHaveBeenCalledTimes(5);
  expect(terminateWorkspace).toHaveBeenCalledOnce();
  expect(terminateWorkspace).toHaveBeenCalledOnce();
});
