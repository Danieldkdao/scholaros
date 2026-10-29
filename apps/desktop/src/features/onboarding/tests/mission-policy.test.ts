import { describe, expect, it } from 'vitest';
import {
  assertMissionNavigation,
  isStaleNavigation,
  resolveMissionEntry,
} from '../lib/mission-policy';
import type { AcademicConnection } from '../types';

const hosts = [
  'canvas.school.edu',
  'classroom.google.com',
  'www.pearson.com',
  'usd497.schoology.com',
  'portal.example.edu',
];

const connection = (
  overrides: Partial<AcademicConnection>,
): AcademicConnection => ({
  id: 'connection',
  name: 'Resource',
  url: 'https://canvas.school.edu/courses',
  host: 'canvas.school.edu',
  kind: 'canvas',
  status: 'verified',
  verifiedAt: null,
  ...overrides,
});

describe('mission entry policy', () => {
  it('keeps a stored read-only page as the mission entry', () => {
    expect(resolveMissionEntry(connection({}), hosts)).toEqual({
      kind: 'ready',
      url: 'https://canvas.school.edu/courses',
    });
  });

  it('falls back to the Canvas course list when the stored URL is rejected', () => {
    expect(
      resolveMissionEntry(
        connection({
          url: 'https://canvas.school.edu/profile/settings?tab=access',
        }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url: 'https://canvas.school.edu/courses' });
  });

  it('falls back to the Classroom home for a stored root URL', () => {
    expect(
      resolveMissionEntry(
        connection({
          kind: 'classroom',
          host: 'classroom.google.com',
          url: 'https://classroom.google.com/',
        }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url: 'https://classroom.google.com/u/0/h' });
  });

  it('explains a stored page that is not a safe read destination', () => {
    const result = resolveMissionEntry(
      connection({
        kind: 'resource',
        host: 'www.pearson.com',
        url: 'https://www.pearson.com/logout',
      }),
      hosts,
    );
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported')
      expect(result.message).toContain('sign-in or account action link');
  });

  it('accepts a confirmed generic home page instead of refusing it', () => {
    expect(
      resolveMissionEntry(
        connection({
          kind: 'resource',
          host: 'www.pearson.com',
          url: 'https://www.pearson.com/',
        }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url: 'https://www.pearson.com/' });
  });

  it('keeps a generic resource when its stored page is read-only', () => {
    expect(
      resolveMissionEntry(
        connection({
          kind: 'resource',
          host: 'www.pearson.com',
          url: 'https://www.pearson.com/courses/biology',
        }),
        hosts,
      ),
    ).toEqual({
      kind: 'ready',
      url: 'https://www.pearson.com/courses/biology',
    });
  });

  it('rejects a stored login page rather than treating confirmation as access', () => {
    const result = resolveMissionEntry(
      connection({
        url: 'https://canvas.school.edu/login',
        kind: 'resource',
      }),
      hosts,
    );
    expect(result.kind).toBe('unsupported');
  });

  it('uses a confirmed Schoology home page as the discovery entry', () => {
    expect(
      resolveMissionEntry(
        connection({
          kind: 'resource',
          host: 'usd497.schoology.com',
          name: 'Home | Schoology',
          url: 'https://usd497.schoology.com/',
          status: 'confirmed',
        }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url: 'https://usd497.schoology.com/' });
  });

  it.each([
    'https://usd497.schoology.com/home_page?nav=42',
    'https://portal.example.edu/dashboard#/courses',
    'https://portal.example.edu/learning',
  ])('never requires a Canvas or Classroom shaped url to start: %s', (url) => {
    const host = new URL(url).hostname;
    expect(
      resolveMissionEntry(
        connection({ kind: 'resource', host, url, status: 'confirmed' }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url });
  });

  it('never carries a stored credential parameter into the entry page', () => {
    const result = resolveMissionEntry(
      connection({
        kind: 'resource',
        host: 'portal.example.edu',
        url: 'https://portal.example.edu/home?token=abc123',
        status: 'confirmed',
      }),
      hosts,
    );
    expect(result).toEqual({
      kind: 'ready',
      url: 'https://portal.example.edu/home',
    });
  });

  it('still uses the provider course list when the stored page is unsafe', () => {
    expect(
      resolveMissionEntry(
        connection({
          url: 'https://canvas.school.edu/course/1/grades/edit',
        }),
        hosts,
      ),
    ).toEqual({ kind: 'ready', url: 'https://canvas.school.edu/courses' });
  });

  it.each([
    'https://usd497.schoology.com/course/12345?tab=overview',
    'https://usd497.schoology.com/#/sections/9',
  ])('accepts a redirect that stays on an authorized read page: %s', (url) => {
    expect(() => assertMissionNavigation(url, hosts)).not.toThrow();
  });

  it.each([
    'https://usd497.schoology.com/logout',
    'https://usd497.schoology.com/course/123/section/4/submission',
    'https://usd497.schoology.com/?session=abc123',
    'https://other-site.example.org/home_page',
  ])('rejects a redirect that leaves the safe area: %s', (url) => {
    expect(() => assertMissionNavigation(url, hosts)).toThrow(
      'This page left the read-only course area.',
    );
  });

  it('blocks a destination that redirected outside the read-only area', () => {
    expect(() =>
      assertMissionNavigation(
        'https://canvas.school.edu/assignments/1/submit',
        ['canvas.school.edu'],
      ),
    ).toThrow('This page left the read-only course area.');
    expect(() =>
      assertMissionNavigation('https://canvas.school.edu/courses/1', hosts),
    ).not.toThrow();
  });

  it('accepts a navigation target that is still present on the same page', () => {
    expect(
      isStaleNavigation(
        'https://canvas.school.edu/courses',
        {
          url: 'https://canvas.school.edu/courses',
          links: [
            {
              url: 'https://canvas.school.edu/courses/1',
              label: 'Biology 101',
            },
          ],
        },
        {
          url: 'https://canvas.school.edu/courses/1',
          label: 'Biology 101',
        },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: 'moved pages',
      fresh: {
        url: 'https://canvas.school.edu/dashboard',
        links: [
          { url: 'https://canvas.school.edu/courses/1', label: 'Biology 101' },
        ],
      },
    },
    {
      name: 'relabeled links',
      fresh: {
        url: 'https://canvas.school.edu/courses',
        links: [
          {
            url: 'https://canvas.school.edu/courses/1',
            label: 'Chemistry 201',
          },
        ],
      },
    },
    {
      name: 'links that disappeared',
      fresh: { url: 'https://canvas.school.edu/courses', links: [] },
    },
  ])('rejects a navigation target that went stale: $name', ({ fresh }) => {
    expect(
      isStaleNavigation('https://canvas.school.edu/courses', fresh, {
        url: 'https://canvas.school.edu/courses/1',
        label: 'Biology 101',
      }),
    ).toBe(true);
  });
});
