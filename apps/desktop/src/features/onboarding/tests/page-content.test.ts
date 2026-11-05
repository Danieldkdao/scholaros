import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPage, readPageUrl } from '../services/page-content';

const snapshotFor = (url: string) => ({
  evaluate: vi.fn(async () => ({
    url,
    title: 'Home',
    text: 'Biology 101 sections',
    links: [
      {
        label: 'Biology 101',
        url: `${url.replace(/\/$/, '')}/course/12345`,
      },
    ],
    password: false,
    error: false,
  })),
});

const read = (url: string) =>
  readPage(snapshotFor(url) as unknown as Parameters<typeof readPage>[0]);

describe('observed page identity', () => {
  it('keeps the query and fragment that distinguish the observed page', async () => {
    const snapshot = await read(
      'https://usd497.schoology.com/home_page?nav=42#/sections/9',
    );
    expect(snapshot.url).toBe(
      'https://usd497.schoology.com/home_page?nav=42#/sections/9',
    );
  });

  it('reports two query routes as two different pages', async () => {
    const first = await read('https://portal.example.edu/search?q=biology');
    const second = await read('https://portal.example.edu/search?q=chemistry');
    expect(first.url).not.toBe(second.url);
  });

  it('removes credential parameters before the url reaches evidence or diagnostics', async () => {
    const snapshot = await read(
      'https://portal.example.edu/home?token=abc&view=all',
    );
    expect(snapshot.url).toBe('https://portal.example.edu/home?view=all');
    expect(snapshot.url).not.toContain('abc');
  });

  it('refuses a policy-violating url before it reaches evidence', async () => {
    const url = 'https://portal.example.edu/logout';
    await expect(read(url)).rejects.toThrow();
  });

  it('passes the observed link destinations through untouched', async () => {
    const snapshot = await read('https://usd497.schoology.com/');
    expect(snapshot.links).toEqual([
      {
        label: 'Biology 101',
        url: 'https://usd497.schoology.com/course/12345',
      },
    ]);
  });
});

it('refuses a credential-bearing SPA fragment instead of returning its raw URL', async () => {
  await expect(
    read('https://portal.example.edu/#/courses?access_token=secret'),
  ).rejects.toThrow();
});

it('rejects a rate-limit page before it can be treated as academic evidence', async () => {
  const page = snapshotFor('https://limited.example/home');
  page.evaluate.mockResolvedValue({
    url: 'https://limited.example/home',
    title: 'Please slow down',
    text: 'Too many requests. Please try again later.',
    links: [],
    password: false,
    error: false,
  });
  await expect(readPage(page as never)).rejects.toThrow('slow down');
});

beforeEach(() => configureBrowserPolicy(['logout']));

it('reads the current DOM URL without consulting Stagehand cached metadata', async () => {
  const page = {
    evaluate: vi.fn(async () => 'https://school.example/home#/courses'),
    url: vi.fn(async () => 'https://school.example/old'),
    waitForLoadState: vi.fn(),
  };
  await expect(readPageUrl(page as never)).resolves.toBe(
    'https://school.example/home#/courses',
  );
  expect(page.url).not.toHaveBeenCalled();
});
it('retries one transient document replacement after bounded DOM settling', async () => {
  const page = {
    evaluate: vi
      .fn()
      .mockRejectedValueOnce(new Error('Execution context destroyed'))
      .mockResolvedValueOnce('https://school.example/home'),
    waitForLoadState: vi.fn(async () => undefined),
  };
  await expect(readPageUrl(page as never)).resolves.toBe(
    'https://school.example/home',
  );
  expect(page.evaluate).toHaveBeenCalledTimes(2);
  expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', 1500);
});
it('does not loop indefinitely when the live document remains unavailable', async () => {
  const page = {
    evaluate: vi.fn().mockRejectedValue(new Error('Page closed')),
    waitForLoadState: vi.fn(async () => undefined),
  };
  await expect(readPageUrl(page as never)).rejects.toThrow('Page closed');
  expect(page.evaluate).toHaveBeenCalledTimes(2);
});

it('retries one destroyed execution context while reading the complete page snapshot', async () => {
  const page = {
    ...snapshotFor('https://school.example/course/1/materials'),
    waitForLoadState: vi.fn(async () => undefined),
  };
  page.evaluate.mockRejectedValueOnce(
    new Error('CDP response failed: Cannot find context with specified id'),
  );
  await expect(readPage(page as never, true)).resolves.toMatchObject({
    url: 'https://school.example/course/1/materials',
    text: 'Biology 101 sections',
  });
  expect(page.evaluate).toHaveBeenCalledTimes(2);
  expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', 1500);
});

it('keeps persistent context failures bounded and never substitutes a cached snapshot', async () => {
  const page = {
    evaluate: vi
      .fn()
      .mockRejectedValue(new Error('Cannot find context with specified id')),
    waitForLoadState: vi.fn(async () => undefined),
  };
  await expect(readPage(page as never, true)).rejects.toThrow(
    'Cannot find context',
  );
  expect(page.evaluate).toHaveBeenCalledTimes(2);
});

it('does not retry closed-page failures during snapshot extraction', async () => {
  const page = {
    evaluate: vi.fn().mockRejectedValue(new Error('Page closed')),
    waitForLoadState: vi.fn(),
  };
  await expect(readPage(page as never, true)).rejects.toThrow('Page closed');
  expect(page.evaluate).toHaveBeenCalledOnce();
  expect(page.waitForLoadState).not.toHaveBeenCalled();
});
