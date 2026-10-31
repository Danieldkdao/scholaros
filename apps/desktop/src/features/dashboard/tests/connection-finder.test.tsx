// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from '@scholaros/ui/components/toast';
import { ConnectionFinder } from '../connection-finder';
import type { ConnectionProposal } from '../../onboarding/types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const proposal: ConnectionProposal = {
  id: 'run-1',
  candidates: [
    { name: 'School Canvas', url: 'https://school.edu/', provider: 'unknown' },
    { name: 'Library', url: 'https://library.edu/', provider: 'unknown' },
  ],
};

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  window.scrollTo = () => undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const type = (element: Element, value: string) =>
  act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

const click = async (element: Element) => {
  await act(async () => {
    for (const kind of [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ])
      element.dispatchEvent(
        kind.startsWith('pointer')
          ? new PointerEvent(kind, { bubbles: true, cancelable: true })
          : new MouseEvent(kind, { bubbles: true, cancelable: true }),
      );
  });
};

const finder = (scholar: Partial<typeof window.scholar>) => {
  window.scholar = {
    resolveConnections: vi.fn(async () => proposal),
    reviseConnectionProposal: vi.fn(async (next: ConnectionProposal) => next),
    approveConnectionProposal: vi.fn(async () => undefined),
    startConnectRun: vi.fn(async () => undefined),
    ...scholar,
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ConnectionFinder));
  });
  return {
    container,
    dialog: () =>
      document.querySelector<HTMLElement>('[data-slot="dialog-content"]'),
    prompt: () => container.querySelector('textarea')!,
    hostInput: () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Destination site address"]',
      )!,
    byText: (text: string) =>
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(text),
      )!,
    byLabel: (label: string) =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      )!,
  };
};

const searchForSchool = async (handle: ReturnType<typeof finder>) => {
  await type(handle.prompt(), 'School');
  await click(handle.byText('Find sites'));
};

it('reviews the suggested sites in a dialog instead of on the card', async () => {
  const handle = finder({});
  await searchForSchool(handle);
  const dialog = handle.dialog();
  expect(dialog?.textContent).toContain('School Canvas');
  expect(dialog?.textContent).not.toContain('login.school.edu');
  expect(dialog?.textContent).not.toContain('Sign-in hosts');
  expect(dialog?.textContent).not.toContain('Sites to connect');
  // The review shows hostnames, never raw addresses, and no longer crowds the
  // finder card itself.
  expect(dialog?.textContent).not.toContain('https://school.edu/');
  expect(handle.container.textContent).not.toContain('Sign-in hosts');
});

it('separates each reviewed entry and names the site above its address', async () => {
  const handle = finder({});
  await searchForSchool(handle);
  const dialog = handle.dialog()!;
  const rows = [...dialog.querySelectorAll('[data-slot="review-entry"]')];
  expect(rows).toHaveLength(2);
  expect(dialog.querySelectorAll('[data-slot="separator"]')).toHaveLength(1);
  const [name, host] = rows[0]!.querySelectorAll('[data-slot="review-line"]');
  expect(name?.textContent).toBe('School Canvas');
  expect(host?.textContent).toBe('school.edu');
  expect(rows[0]!.querySelector('svg.lucide-globe')).toBeTruthy();
});

it('removes a reviewed site through its destructive icon button', async () => {
  const revise = vi.fn(async (next: ConnectionProposal) => next);
  const handle = finder({ reviseConnectionProposal: revise });
  await searchForSchool(handle);
  await click(handle.byLabel('Remove School Canvas'));
  expect(revise).toHaveBeenCalledOnce();
  expect(revise.mock.calls[0]![0].candidates).toEqual([
    { name: 'Library', url: 'https://library.edu/', provider: 'unknown' },
  ]);
});

it('adds a site from the plus control beside the address field', async () => {
  const revise = vi.fn(async (next: ConnectionProposal) => next);
  const handle = finder({ reviseConnectionProposal: revise });
  await searchForSchool(handle);
  await type(handle.hostInput(), 'books.edu');
  await click(handle.byLabel('Add destination site'));
  expect(revise).toHaveBeenCalledOnce();
  expect(revise.mock.calls[0]![0].candidates.at(-1)).toEqual({
    name: 'books.edu',
    url: 'https://books.edu/',
    provider: 'unknown',
  });
});

it('approves from the sticky footer beside the cancel control', async () => {
  const approve = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const handle = finder({
    approveConnectionProposal: approve,
    startConnectRun: start,
  });
  await searchForSchool(handle);
  const footer = handle.dialog()!.querySelector('[data-slot="dialog-footer"]')!;
  expect(footer.textContent).toContain('Cancel');
  expect(footer.textContent).toContain('Approve sites');
  await click(handle.byText('Approve sites'));
  expect(approve).toHaveBeenCalledWith(proposal);
  expect(start).toHaveBeenCalledWith('run-1');
  expect(handle.dialog()).toBeNull();
});

it('closes the review from cancel and can be reopened', async () => {
  const handle = finder({});
  await searchForSchool(handle);
  await click(handle.byText('Cancel'));
  expect(handle.dialog()).toBeNull();
  await click(handle.byText('Review sites'));
  expect(handle.dialog()).toBeTruthy();
});

it('reports a failed start outside the closed dialog', async () => {
  const handle = finder({
    startConnectRun: vi.fn(async () => {
      throw new Error('Browser unavailable');
    }),
  });
  await searchForSchool(handle);
  await click(handle.byText('Approve sites'));
  expect(handle.dialog()).toBeNull();
  expect(handle.container.textContent).toContain('Find sites again');
});

it('shows a resolution failure and recovers on the next attempt', async () => {
  const resolve = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(proposal);
  const handle = finder({ resolveConnections: resolve });
  await type(handle.prompt(), 'School');
  await click(handle.byText('Find sites'));
  expect(handle.container.textContent).toContain('offline');
  await click(handle.byText('Find sites'));
  expect(handle.dialog()?.textContent).toContain('school.edu');
});

it('invites an example request in the finder textarea', async () => {
  const handle = finder({});
  const input = handle.prompt();
  expect(input.placeholder).toMatch(/e\.g\./i);
  expect(input.placeholder).toContain('Canvas');
  expect(input.id).toBe('connection-request');
  expect(input.value).toBe('');
});

it('shows a toast without opening review when no sites are found', async () => {
  const notify = vi.spyOn(toast, 'error');
  const handle = finder({
    resolveConnections: vi.fn(async () => ({ ...proposal, candidates: [] })),
  });
  await searchForSchool(handle);
  expect(handle.dialog()).toBeNull();
  expect(handle.byText('Review sites')).toBeUndefined();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/no sites found/i));
  notify.mockRestore();
});

it('passes a broad subject request through to review without requiring a school', async () => {
  const math = {
    id: 'math-search',
    candidates: [
      {
        name: 'Khan Academy Math',
        url: 'https://www.khanacademy.org/math',
        provider: 'unknown' as const,
      },
    ],
  };
  const resolve = vi.fn(async () => math);
  const handle = finder({ resolveConnections: resolve });
  await type(handle.prompt(), 'find some math websites');
  await click(handle.byText('Find sites'));
  expect(resolve).toHaveBeenCalledWith('find some math websites');
  expect(handle.dialog()?.textContent).toContain('Khan Academy Math');
  expect(window.scholar.approveConnectionProposal).not.toHaveBeenCalled();
  await click(handle.byText('Approve sites'));
  expect(window.scholar.approveConnectionProposal).toHaveBeenCalledWith(math);
  expect(window.scholar.startConnectRun).toHaveBeenCalledWith('math-search');
});

it.each([
  ['https://books.edu/courses/math?view=all#lesson', 'books.edu'],
  ['  HTTPS://BOOKS.EDU:443/login?token=discard-this  ', 'books.edu'],
  ['books.edu/courses/math', 'books.edu'],
])(
  'extracts the hostname from a pasted site address: %s',
  async (address, host) => {
    const revise = vi.fn(async (next: ConnectionProposal) => next);
    const handle = finder({ reviseConnectionProposal: revise });
    await searchForSchool(handle);
    await type(handle.hostInput(), address);
    await click(handle.byLabel('Add destination site'));
    expect(revise).toHaveBeenCalledOnce();
    expect(revise.mock.calls[0]![0].candidates.at(-1)).toEqual({
      name: host,
      url: `https://${host}/`,
      provider: 'unknown',
    });
  },
);

it.each([
  'http://books.edu/math',
  'https://',
  'https://localhost/math',
  'https://127.0.0.1/math',
  'https://student:password@books.edu/math',
  'https://books.edu:8443/math',
])('keeps site validation when normalizing an address: %s', async (address) => {
  const revise = vi.fn(async (next: ConnectionProposal) => next);
  const handle = finder({ reviseConnectionProposal: revise });
  await searchForSchool(handle);
  await type(handle.hostInput(), address);
  await click(handle.byLabel('Add destination site'));
  expect(revise).not.toHaveBeenCalled();
  expect(handle.dialog()?.querySelector('[role="alert"]')).not.toBeNull();
});
