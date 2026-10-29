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
