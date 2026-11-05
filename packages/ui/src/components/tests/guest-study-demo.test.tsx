// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GuestStudyDemo } from '../guest-study-demo';
let root: Root | undefined;
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((node) => node.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
it('offers a meaningful synthetic walkthrough without services or authentication', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  expect(container.textContent).toContain('Sample data');
  expect(container.textContent).toContain('No account needed');
  await click('Context');
  const note = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(note, 'I learn by trying examples.');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(note.value).toBe('I learn by trying examples.');
  await click('Study');
  expect(container.textContent).toContain('I learn by trying examples.');
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toContain('0\n1\n2');
  const slider = container.querySelector<HTMLElement>('input[type="range"]')!;
  expect(slider).not.toBeNull();
  expect(
    document.getElementById(slider.getAttribute('aria-labelledby')!)
      ?.textContent,
  ).toContain('Repetitions');
  await act(async () =>
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  );
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toBe('0\n1\n2\n3');
  await click('1, 2, 3');
  expect(container.textContent).toContain('Try again.');
  await click('0, 1, 2');
  expect(container.textContent).toContain('Exactly.');
  expect(container.textContent).toContain(
    'Your full AI workspace and connected courses require sign-in',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('honors explicit exit and sign-in actions', async () => {
  const onExit = vi.fn();
  const onSignIn = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(createElement(GuestStudyDemo, { onExit, onSignIn })),
  );
  await click('Exit demo');
  await click('Sign in');
  expect(onExit).toHaveBeenCalledOnce();
  expect(onSignIn).toHaveBeenCalledOnce();
});

it('calls only the fixed anonymous sample action and keeps live output separate', async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({
      text: 'A live explanation of a loop.',
      model: 'muse-spark-1.3',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(GuestStudyDemo, { apiBaseURL: 'http://localhost:3000' }),
    ),
  );
  await click('Study');
  await click('Ask Meta to explain loops');
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/api/demo/tutor');
  const options = fetch.mock.calls[0]![1] as RequestInit;
  expect(options.credentials).toBe('omit');
  expect(options.body).toBe('{"action":"explain"}');
  expect(container.textContent).toContain('A live explanation of a loop.');
  expect(container.textContent).toContain('Live response · muse-spark-1.3');
});

it('keeps the sample usable when the live demo is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: 'private server detail' }, { status: 503 }),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  await click('Study');
  await click('Ask Meta for a practice question');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'not enabled',
  );
  expect(container.textContent).not.toContain('private server detail');
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toBe('0\n1\n2');
});
