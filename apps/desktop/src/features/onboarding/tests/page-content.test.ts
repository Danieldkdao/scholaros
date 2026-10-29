import { describe, expect, it, vi } from 'vitest';
import { readPage } from '../services/page-content';

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
