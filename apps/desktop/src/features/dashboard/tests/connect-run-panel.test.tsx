// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectRunPanel } from '../connect-run-panel';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});
it('shows the handoff across the shell and resumes or stops only on user action', async () => {
  const current = {
    accountId: 'student',
    status: 'awaiting-user',
    awaiting: {
      host: 'accounts.google.com',
      destination: 'school.edu',
      note: null,
    },
    events: [],
    results: [],
  };
  const resume = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  window.scholar = {
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getConnectRun: vi.fn(async () => current),
    onConnectChange: vi.fn(() => () => {}),
    resumeConnectRun: resume,
    cancelConnectRun: cancel,
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ConnectRunPanel));
  });
  expect(container.textContent).toContain('school.edu');
  expect(container.textContent).not.toContain('Sign-in host');
  expect(container.textContent).not.toContain('accounts.google.com');
  expect(resume).not.toHaveBeenCalled();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Continue"]')!
      .click(),
  );
  expect(resume).toHaveBeenCalledOnce();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!
      .click(),
  );
  expect(cancel).toHaveBeenCalledOnce();
});

it('leaves the run going when only the panel unmounts', async () => {
  const cancel = vi.fn(async () => undefined);
  window.scholar = {
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getConnectRun: vi.fn(async () => ({
      accountId: 'student',
      status: 'running',
      awaiting: null,
      events: [],
      results: [],
    })),
    onConnectChange: vi.fn(() => () => {}),
    cancelConnectRun: cancel,
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ConnectRunPanel));
  });
  // Navigating away from the add screen hides the run, it does not stop it.
  await act(async () => root.unmount());
  expect(cancel).not.toHaveBeenCalled();
});

it('lists each run outcome with its own status icon', async () => {
  window.scholar = {
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getConnectRun: vi.fn(async () => ({
      accountId: 'student',
      status: 'complete',
      awaiting: null,
      events: [],
      results: [
        { host: 'school.edu', status: 'connected' },
        { host: 'library.edu', status: 'needs-sign-in' },
        { host: 'blocked.edu', status: 'blocked' },
      ],
    })),
    onConnectChange: vi.fn(() => () => {}),
    cancelConnectRun: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ConnectRunPanel));
  });
  const rows = [...container.querySelectorAll('[data-slot="connect-result"]')];
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain('school.edu');
  expect(rows[0]?.textContent).toContain('Connected');
  expect(rows[1]?.textContent).toContain('Needs confirmation');
  expect(rows[2]?.textContent).toContain('Blocked');
  for (const row of rows) expect(row.querySelector('svg')).toBeTruthy();
});

it('uses a fresh snapshot when an older event arrived before it was fetched', async () => {
  let listener!: (state: unknown) => void;
  let finishUser!: (user: { id: string }) => void;
  const user = new Promise<{ id: string }>((resolve) => {
    finishUser = resolve;
  });
  window.scholar = {
    getCurrentUser: vi.fn(() => user),
    getConnectRun: vi.fn(async () => ({
      accountId: 'student',
      status: 'complete',
      awaiting: null,
      events: [],
      results: [],
    })),
    onConnectChange: vi.fn((handler) => {
      listener = handler as (state: unknown) => void;
      return () => {};
    }),
    cancelConnectRun: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ConnectRunPanel)));
  await act(async () => {
    listener({
      accountId: 'student',
      status: 'awaiting-user',
      awaiting: { host: 'old.edu', destination: 'old.edu', note: null },
      events: [],
      results: [],
    });
    finishUser({ id: 'student' });
    await user;
  });
  expect(container.textContent).not.toContain('old.edu');
});
