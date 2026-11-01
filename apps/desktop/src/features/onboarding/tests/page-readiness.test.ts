import { describe, expect, it, vi } from 'vitest';
import { waitForMissionPage } from '../services/page-readiness';

vi.mock('../services/page-evidence', () => ({
  readPageEvidence: async () => ({ hasPasswordField: true }),
}));

const ready = {
  ready: true,
  signIn: false,
  documentLoading: false,
  blank: false,
};
const waiting = {
  ready: false,
  signIn: false,
  documentLoading: true,
  blank: true,
};
const rendered = {
  ready: false,
  signIn: false,
  documentLoading: false,
  blank: false,
};

type Readiness = typeof ready;

// The final result repeats, so a page that never changes behaves realistically.
const pageFor = (results: Array<Readiness | Error>) => {
  const tail = results[results.length - 1]!;
  const evaluate = vi.fn(async () => {
    if (tail instanceof Error) throw tail;
    return tail;
  });
  for (const result of results.slice(0, -1)) {
    if (result instanceof Error) evaluate.mockRejectedValueOnce(result);
    else evaluate.mockResolvedValueOnce(result);
  }
  return { evaluate };
};

const options = { timeoutMs: 120, pollMs: 10 };

describe('mission page readiness', () => {
  it('keeps waiting after a transient page probe failure', async () => {
    const page = pageFor([new Error('extension rpc closed'), ready]);

    await expect(
      waitForMissionPage(
        page as unknown as Parameters<typeof waitForMissionPage>[0],
        'canvas',
        new AbortController().signal,
        options,
      ),
    ).resolves.toBeUndefined();
  });

  it('stops as soon as provider content appears', async () => {
    const page = pageFor([waiting, ready]);

    await waitForMissionPage(
      page as unknown as Parameters<typeof waitForMissionPage>[0],
      'canvas',
      new AbortController().signal,
      options,
    );

    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a sign-in page without waiting for content', async () => {
    const page = pageFor([{ ...ready, ready: false, signIn: true }]);

    await expect(
      waitForMissionPage(
        page as unknown as Parameters<typeof waitForMissionPage>[0],
        'resource',
        new AbortController().signal,
        options,
      ),
    ).rejects.toThrow('This resource needs you to sign in again.');
  });

  it('cancels while waiting', async () => {
    const controller = new AbortController();
    const evaluate = vi.fn(async () => waiting);
    const page = { evaluate };
    setTimeout(() => controller.abort(), 20);

    await expect(
      waitForMissionPage(
        page as unknown as Parameters<typeof waitForMissionPage>[0],
        'canvas',
        controller.signal,
        { timeoutMs: 5_000, pollMs: 10 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(evaluate.mock.calls.length).toBeLessThan(200);
  });

  it('accepts a slow page that rendered content by the deadline', async () => {
    const page = pageFor([rendered]);

    await expect(
      waitForMissionPage(
        page as unknown as Parameters<typeof waitForMissionPage>[0],
        'resource',
        new AbortController().signal,
        options,
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a page that never rendered', async () => {
    const page = { evaluate: vi.fn(async () => waiting) };

    await expect(
      waitForMissionPage(
        page as unknown as Parameters<typeof waitForMissionPage>[0],
        'canvas',
        new AbortController().signal,
        options,
      ),
    ).rejects.toThrow('The page didn’t finish loading.');
  });
});

it('bounds a probe that never resolves', async () => {
  const page = { evaluate: vi.fn(() => new Promise(() => undefined)) };
  const start = Date.now();
  await expect(
    waitForMissionPage(
      page as unknown as Parameters<typeof waitForMissionPage>[0],
      'canvas',
      new AbortController().signal,
      { timeoutMs: 25, pollMs: 1 },
    ),
  ).rejects.toThrow('The page didn’t finish loading');
  expect(Date.now() - start).toBeLessThan(300);
}, 1000);
it('cancels immediately even when the browser probe is stalled', async () => {
  const controller = new AbortController();
  const page = { evaluate: vi.fn(() => new Promise(() => undefined)) };
  const pending = waitForMissionPage(
    page as unknown as Parameters<typeof waitForMissionPage>[0],
    'canvas',
    controller.signal,
    { timeoutMs: 5000 },
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
}, 1000);

it('surfaces a protection failure immediately instead of reporting a loading timeout', async () => {
  const page = pageFor([waiting]);
  await expect(
    waitForMissionPage(
      page as never,
      'resource',
      new AbortController().signal,
      {
        ...options,
        assertReadable: () => {
          throw new Error('This resource needs you to sign in again.');
        },
      },
    ),
  ).rejects.toThrow('needs you to sign in again');
  expect(page.evaluate).not.toHaveBeenCalled();
});
