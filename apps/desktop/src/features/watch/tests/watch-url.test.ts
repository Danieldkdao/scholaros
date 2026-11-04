import { describe, expect, it } from 'vitest';
import {
  watchSettingsSchema,
  watchUrlInputSchema,
  watchUrlsSchema,
} from '../schemas';
import { getEffectiveWatchTargetInputs, parseWatchUrl } from '../lib/watch-url';

const connections = [
  { id: 'connection-a', host: 'school.edu', isCourseResource: true },
  { id: 'connection-b', host: 'portal.school.edu', isCourseResource: false },
];

describe('watch URL parsing', () => {
  it('trims surrounding whitespace and preserves path, query order, and hash routes', () => {
    expect(
      parseWatchUrl(
        '  https://school.edu/courses/biology/?week=2&week=1#/assignments  ',
        connections,
      ),
    ).toEqual({
      url: 'https://school.edu/courses/biology/?week=2&week=1#/assignments',
      identity:
        'https://school.edu/courses/biology/?week=2&week=1#/assignments',
      connectionId: 'connection-a',
    });
  });

  it('canonicalizes default HTTPS ports without changing the meaningful route', () => {
    expect(
      parseWatchUrl(
        'https://school.edu:443/courses/biology#assignments',
        connections,
      ).identity,
    ).toBe('https://school.edu/courses/biology#assignments');
  });

  it('requires a configured course-resource connection for the exact host', () => {
    expect(() =>
      parseWatchUrl('https://portal.school.edu/courses', connections),
    ).toThrow('Connect this resource before adding its URL.');
    expect(() =>
      parseWatchUrl('https://other.edu/courses', connections),
    ).toThrow('Connect this resource before adding its URL.');
  });

  it.each([
    'http://school.edu/courses',
    'ftp://school.edu/courses',
    'https://',
    'https://localhost/courses',
    'https://school.local/courses',
    'https://127.0.0.1/courses',
    'https://[::1]/courses',
    'https://school.edu:8443/courses',
    'https://student@school.edu/courses',
    'https://student:secret@school.edu/courses',
    'https://school.edu/courses?access_token=secret',
    'https://school.edu/courses#state=secret',
    'https://school.edu/courses\nhttps://other.edu/',
    'https://school.edu/course\u0001s',
  ])('rejects unsafe or unsupported URL input %s', (url) => {
    expect(() => parseWatchUrl(url, connections)).toThrow();
  });

  it('rejects oversize input before producing a truncated identity', () => {
    const url = `https://school.edu/${'a'.repeat(2050)}`;

    expect(() => parseWatchUrl(url, connections)).toThrow();
  });

  it('limits custom URL count and input size in the shared watch contracts', () => {
    expect(
      watchUrlInputSchema.safeParse({ url: 'https://school.edu/' }).success,
    ).toBe(true);
    expect(
      watchUrlInputSchema.safeParse({ url: 'x'.repeat(2049) }).success,
    ).toBe(false);
    expect(
      watchUrlsSchema.safeParse(Array(20).fill('https://school.edu/')).success,
    ).toBe(true);
    expect(
      watchUrlsSchema.safeParse(Array(21).fill('https://school.edu/')).success,
    ).toBe(false);
    expect(
      watchSettingsSchema.safeParse({
        watchEnabled: true,
        watchUrls: ['https://school.edu/'],
      }).success,
    ).toBe(true);
  });

  it('uses resource home pages by default and replaces them with custom routes', () => {
    const resources = [
      {
        id: 'connection-a',
        host: 'school.edu',
        isCourseResource: true,
        status: 'verified' as const,
        url: 'https://school.edu/home',
      },
      {
        id: 'connection-b',
        host: 'portal.school.edu',
        isCourseResource: true,
        status: 'confirmed' as const,
        url: 'https://portal.school.edu/courses',
      },
      {
        id: 'connection-c',
        host: 'school.edu',
        isCourseResource: false,
        status: 'verified' as const,
        url: 'https://school.edu/calendar',
      },
    ];

    expect(
      getEffectiveWatchTargetInputs(
        { watchEnabled: true, watchUrls: [] },
        resources,
      ),
    ).toMatchObject([
      { connectionId: 'connection-a', requestedUrl: 'https://school.edu/home' },
      {
        connectionId: 'connection-b',
        requestedUrl: 'https://portal.school.edu/courses',
      },
    ]);
    expect(
      getEffectiveWatchTargetInputs(
        {
          watchEnabled: true,
          watchUrls: ['https://school.edu/courses/biology/assignments'],
        },
        resources,
      ),
    ).toMatchObject([
      {
        connectionId: 'connection-a',
        requestedUrl: 'https://school.edu/courses/biology/assignments',
      },
    ]);
    expect(
      getEffectiveWatchTargetInputs(
        { watchEnabled: false, watchUrls: [] },
        resources,
      ),
    ).toEqual([]);
  });
});
