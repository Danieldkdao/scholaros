// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@browserbasehq/stagehand';
import {
  disconnectPageObserver,
  installPageObserver,
  readPageMutationState,
} from '../services/page-observer';

const createPage = () => {
  const page = {
    addInitScript: vi.fn(async () => undefined),
    evaluate: async <T, A>(
      script: (argument: A) => T | Promise<T>,
      argument?: A,
    ) => script(argument as A),
  };
  return page as unknown as Page;
};

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

describe('watch page observer', () => {
  it('installs before navigation and observes content-root replacement', async () => {
    const page = createPage();
    await installPageObserver(page);
    const initial = await readPageMutationState(page);

    expect(page.addInitScript).toHaveBeenCalledOnce();
    expect(initial.installed).toBe(true);
    document.body.innerHTML = '<main>Course work</main>';
    await flushMutations();

    const updated = await readPageMutationState(page);
    expect(updated.revision).toBeGreaterThan(initial.revision);
  });

  it('ignores application-owned markers and detects SPA URL changes', async () => {
    const page = createPage();
    await installPageObserver(page);
    const initial = await readPageMutationState(page);
    const owned = document.createElement('div');
    owned.setAttribute('data-scholaros-watch-owned', 'true');
    owned.textContent = 'Internal marker';
    document.body.append(owned);
    await flushMutations();
    expect((await readPageMutationState(page)).revision).toBe(initial.revision);

    history.pushState(null, '', '/courses/1/assignments#upcoming');
    const routeChange = await readPageMutationState(page);
    expect(routeChange.url).toContain('#upcoming');
    expect(routeChange.revision).toBeGreaterThan(initial.revision);
  });

  it('disconnects its observer during cleanup', async () => {
    const page = createPage();
    await installPageObserver(page);
    expect((await readPageMutationState(page)).installed).toBe(true);

    await disconnectPageObserver(page);
    document.body.innerHTML = '<main>Changed after cleanup</main>';
    await flushMutations();

    expect((await readPageMutationState(page)).installed).toBe(false);
  });
});
