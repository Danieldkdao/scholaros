// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://school.example/"}
import { afterEach, expect, it, vi } from 'vitest';
import { waitForMissionPage } from '../services/page-readiness';
import { readPage } from '../services/page-content';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
it('reads a sparse course page even when an unused main element is empty', async () => {
  document.body.innerHTML =
    '<main></main><section><a href="/course/1">Art</a></section>';
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
  });
  const page = {
    evaluate: async (fn: (...args: unknown[]) => unknown, arg?: unknown) =>
      fn(arg),
  };
  await expect(
    waitForMissionPage(
      page as never,
      'resource',
      new AbortController().signal,
      { timeoutMs: 80, pollMs: 5 },
    ),
  ).resolves.toBeUndefined();
  expect((await readPage(page as never)).text).toBe('Art');
});

it.each(['display: none', 'visibility: hidden', 'opacity: 0'])(
  'reads an authenticated dashboard with a hidden password form: %s',
  async (style) => {
    document.body.innerHTML = `<main><a href="/course/1">Biology 101</a></main><div style="${style}"><input type="password"></div>`;
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      { width: 100, height: 30 },
    ] as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 30,
    } as DOMRect);
    const page = {
      evaluate: async (fn: (...args: unknown[]) => unknown, arg?: unknown) =>
        fn(arg),
    };
    await expect(
      waitForMissionPage(
        page as never,
        'resource',
        new AbortController().signal,
        { timeoutMs: 80, pollMs: 5 },
      ),
    ).resolves.toBeUndefined();
    expect((await readPage(page as never)).password).toBe(false);
  },
);

it('still refuses a visible password form', async () => {
  document.body.innerHTML = '<main>Sign in</main><input type="password">';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 30,
  } as DOMRect);
  const page = {
    evaluate: async (fn: (...args: unknown[]) => unknown, arg?: unknown) =>
      fn(arg),
  };
  await expect(
    waitForMissionPage(
      page as never,
      'resource',
      new AbortController().signal,
      { timeoutMs: 80, pollMs: 5 },
    ),
  ).rejects.toThrow('sign in again');
  expect((await readPage(page as never)).password).toBe(true);
});

it('reads all visible page content and links beyond the old snapshot cutoffs', async () => {
  const text = 'Assignment content '.repeat(1200);
  document.body.innerHTML = `<main>${text}</main>${Array.from({ length: 350 }, (_, index) => `<a href="/course/${index}">Course ${index}</a>`).join('')}`;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
  });
  const page = {
    evaluate: async (fn: (arg: boolean) => unknown, arg: boolean) => fn(arg),
  };
  const snapshot = await readPage(page as never, true);
  expect(snapshot.text.length).toBeGreaterThan(16000);
  expect(snapshot.links).toHaveLength(350);
  expect(snapshot.linksTruncated).toBe(false);
});
