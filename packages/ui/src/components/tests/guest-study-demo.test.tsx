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
    'Live AI and connected courses require sign-in',
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
