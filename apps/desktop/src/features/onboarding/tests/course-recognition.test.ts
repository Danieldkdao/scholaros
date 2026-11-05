import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  discoveryEntriesFromPage,
  nextCourseListTarget,
  onlyObservedDestinations,
} from '../lib/academic-discovery';
import type { AcademicConnection } from '../types';

const schoology = 'usd497.schoology.com';

const connection = (
  overrides: Partial<AcademicConnection> = {},
): AcademicConnection => ({
  id: 'connection-schoology',
  name: 'Home | Schoology',
  url: `https://${schoology}/`,
  host: schoology,
  kind: 'resource',
  status: 'confirmed',
  verifiedAt: null,
  notes: null,
  favicon: null,
  isCourseResource: false,
  ...overrides,
});

const page = (
  url: string,
  title: string,
  links: Array<{ label: string; url: string; context?: string }>,
) => ({ url, title, links });

const course = (label: string, path: string, context?: string) => ({
  label,
  url: `https://${schoology}${path}`,
  context,
});

describe('course recognition from observed content', () => {
  it('recognizes courses whose paths match no known product url shape', () => {
    const host = 'learning.example.edu';
    const entries = discoveryEntriesFromPage(
      connection({ host, url: `https://${host}/`, name: 'Learning portal' }),
      page(`https://${host}/`, 'Courses', [
        { label: 'Biology 101', url: `https://${host}/learning/item/12345` },
        {
          label: 'World History B',
          url: `https://${host}/my-classes/history`,
          context: 'Current course',
        },
        {
          label: 'Algebra II - Period 3',
          url: `https://${host}/sections/4321`,
        },
      ]),
    );
    expect(
      entries
        .filter((entry) => entry.role === 'course')
        .map((entry) => entry.label),
    ).toEqual(['Biology 101', 'World History B', 'Algebra II - Period 3']);
  });

  it('does not treat an unsupported Schoology resource route as an enrollment', () => {
    const entries = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/`, 'Courses', [
        course('Algebra II - Period 3', '/sections/4321'),
      ]),
    );
    expect(
      entries.find(({ label }) => label === 'Algebra II - Period 3')?.role,
    ).toBe('resource');
    expect(entries.filter(({ role }) => role === 'course')).toEqual([]);
  });

  it('uses nearby context when the label alone is a title', () => {
    const entries = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/course`, 'Courses', [
        course('Composition Seminar', '/course/99001', 'Fall 2026 Section A'),
      ]),
    );
    expect(entries[0]).toMatchObject({
      role: 'course',
      label: 'Composition Seminar',
      url: `https://${schoology}/course/99001`,
    });
  });

  it.each([
    course('Help', '/help'),
    course('Log out', '/logout'),
    course('Privacy Policy', '/privacy'),
    course('Install apps', '/get-the-app'),
    course('School calendar', '/calendar'),
    course('Notifications', '/alerts'),
    course('Search', '/search'),
  ])('excludes a site affordance link: %s', (link) => {
    const entries = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/`, 'Home', [
        link,
        course('Biology 101', '/course/12345'),
      ]),
    );
    expect(entries.map((entry) => entry.label)).not.toContain(link.label);
  });

  it.each([
    course('Chemistry catalog', '/course/100', 'Browse the course catalog'),
    course('Robotics club', '/group/55', 'Community group'),
    course('Biology 101 (archived)', '/course/12345', 'Past courses'),
  ])('excludes a link that is not current enrollment evidence: %s', (link) => {
    const entries = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/`, 'Home', [link]),
    );
    expect(entries.map((entry) => entry.url)).not.toContain(link.url);
  });

  it('ignores destinations that leave the authorized host or the safe area', () => {
    const entries = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/`, 'Home', [
        { label: 'Physics 1', url: 'https://other.example.org/course/9' },
        { label: 'Chemistry 2', url: `https://${schoology}/course/9/submit` },
        { label: 'Stats 3', url: `https://${schoology}/course/3?token=abc` },
        course('Geology 101', '/course/777'),
      ]),
    );
    const urls = entries.map((entry) => entry.url);
    expect(urls).not.toContain('https://other.example.org/course/9');
    expect(urls).not.toContain(`https://${schoology}/course/9/submit`);
    expect(urls).not.toContain(`https://${schoology}/course/3?token=abc`);
    expect(entries.find((entry) => entry.label === 'Geology 101')?.role).toBe(
      'course',
    );
  });

  it('keeps provenance for every observation', () => {
    const [entry] = discoveryEntriesFromPage(
      connection(),
      page(`https://${schoology}/home_page?nav=42`, 'Courses', [
        course('Biology 101', '/course/12345'),
      ]),
    );
    expect(entry).toMatchObject({
      connectionId: 'connection-schoology',
      label: 'Biology 101',
      url: `https://${schoology}/course/12345`,
      evidenceUrl: `https://${schoology}/home_page?nav=42`,
      role: 'course',
    });
  });
});

describe('bounded navigation toward a course list', () => {
  it('steps from a home page to the observed course list', () => {
    const target = nextCourseListTarget(
      page(`https://${schoology}/`, 'Home', [
        course('Grades', '/grades'),
        course('Courses', `/courses`),
        course('Messages', '/inbox'),
      ]),
      new Set([`https://${schoology}/`]),
    );
    expect(target).toEqual({
      label: 'Courses',
      url: `https://${schoology}/courses`,
    });
  });

  it.each(['All courses', 'My Classes', 'Sections', 'Class list'])(
    'accepts the course list affordance %s',
    (label) => {
      const target = nextCourseListTarget(
        page(`https://${schoology}/`, 'Home', [course(label, '/courses')]),
        new Set<string>(),
      );
      expect(target?.url).toBe(`https://${schoology}/courses`);
    },
  );

  it('stops when the affordance was already visited', () => {
    expect(
      nextCourseListTarget(
        page(`https://${schoology}/`, 'Home', [course('Courses', '/courses')]),
        new Set([`https://${schoology}/courses`]),
      ),
    ).toBeNull();
  });

  it('never proposes a destination the page did not expose', () => {
    expect(
      nextCourseListTarget(
        page(`https://${schoology}/`, 'Home', [course('Help', '/help')]),
        new Set<string>(),
      ),
    ).toBeNull();
  });

  it('rejects a destination that was not observed', () => {
    const observed = [`https://${schoology}/course/12345`];
    expect(
      onlyObservedDestinations(observed, [
        `https://${schoology}/course/12345`,
        `https://${schoology}/course/99999`,
        'https://elsewhere.example.com/course/1',
      ]),
    ).toEqual([`https://${schoology}/course/12345`]);
  });
});

it('does not infer enrollment from ordinary navigation on a Courses-titled page', () => {
  const entries = discoveryEntriesFromPage(
    connection(),
    page(`https://${schoology}/`, 'Courses', [
      course('Courses', '/courses'),
      course('Grades', '/grades'),
      course('Syllabus', '/syllabus'),
    ]),
  );
  expect(entries.filter((entry) => entry.role === 'course')).toEqual([]);
});

it.each([
  'Course Dashboard',
  'Class dashboard',
  'View my courses',
  'View all classes',
])('can follow the observed %s navigation entry', (label) => {
  expect(
    nextCourseListTarget(
      page(`https://${schoology}/`, 'Home', [
        course(label, '/home/course-dashboard'),
      ]),
      new Set([`https://${schoology}/`]),
    )?.url,
  ).toBe(`https://${schoology}/home/course-dashboard`);
});

beforeEach(() => configureBrowserPolicy(['submit']));
