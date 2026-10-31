import { configureBrowserPolicy } from '../../onboarding/lib/browser-policy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  childItemsFrom,
  childPageTarget,
  courseFieldsFrom,
  pageHasMorePages,
  pageListsNothing,
} from '../lib/course-content';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const host = 'canvas.school.edu';
const courseUrl = `https://${host}/courses/1`;
const page = (overrides: Partial<ObservedPage> = {}): ObservedPage => ({
  url: courseUrl,
  title: 'Biology 101',
  text: '',
  links: [],
  ...overrides,
});
const link = (label: string, url: string) => ({ label, url });

describe('reading course fields off a name the source really showed', () => {
  it('does not mistake a term for a catalogue code', () => {
    expect(courseFieldsFrom('World History - Fall 2026')).toEqual({
      code: null,
      term: 'Fall 2026',
    });
  });
  it('separates a catalogue code and a term from the course name', () => {
    expect(courseFieldsFrom('BIOL 101 - Fall 2026')).toEqual({
      code: 'BIOL 101',
      term: 'Fall 2026',
    });
  });

  it('keeps a plain name without inventing a code or term', () => {
    expect(courseFieldsFrom('Introduction to Biology')).toEqual({
      code: null,
      term: null,
    });
  });

  it('reads a code out of a subject name and number', () => {
    expect(courseFieldsFrom('Biology 101')).toEqual({
      code: 'Biology 101',
      term: null,
    });
  });
});

describe('finding the announcements and assignments page among observed links', () => {
  it('picks the course link that names the collection', () => {
    const observed = page({
      links: [
        link('Home', `${courseUrl}/home`),
        link('Announcements', `${courseUrl}/announcements`),
        link('Grades', `${courseUrl}/grades`),
      ],
    });
    expect(childPageTarget(observed, 'announcements', host)).toBe(
      `${courseUrl}/announcements`,
    );
  });

  it('knows the collection each platform words differently', () => {
    const observed = page({
      links: [link('Classwork', `${courseUrl}/classwork`)],
    });
    expect(childPageTarget(observed, 'assignments', host)).toBe(
      `${courseUrl}/classwork`,
    );
  });

  it('never offers a link the read-only policy refuses', () => {
    const observed = page({
      links: [
        link('Announcements', `${courseUrl}/announcements/new`),
        link('Announcements', 'https://evil.example/announcements'),
      ],
    });
    expect(childPageTarget(observed, 'announcements', host)).toBeNull();
  });

  it('returns nothing when the course page has no such link', () => {
    expect(
      childPageTarget(page({ links: [] }), 'assignments', host),
    ).toBeNull();
  });
});

describe('telling an empty list from a list we could not read', () => {
  it('accepts only explicit wording that the collection is empty', () => {
    expect(
      pageListsNothing(
        page({ text: 'There are no announcements to display.' }),
        'announcements',
      ),
    ).toBe(true);
    expect(
      pageListsNothing(page({ text: 'Nothing due yet' }), 'assignments'),
    ).toBe(true);
  });

  it('does not treat a blank or unreadable page as empty', () => {
    expect(pageListsNothing(page({ text: '' }), 'announcements')).toBe(false);
    expect(
      pageListsNothing(page({ text: 'Sign in to continue' }), 'announcements'),
    ).toBe(false);
    expect(
      pageListsNothing(page({ text: 'Announcements' }), 'announcements'),
    ).toBe(false);
  });

  it('spots a page that admits more items exist', () => {
    expect(
      pageHasMorePages(
        page({ links: [link('Next', `${courseUrl}/assignments?page=2`)] }),
      ),
    ).toBe(true);
    expect(
      pageHasMorePages(
        page({ links: [link('Older announcements', courseUrl)] }),
      ),
    ).toBe(true);
    expect(
      pageHasMorePages(page({ links: [link('Syllabus', `${courseUrl}/s`)] })),
    ).toBe(false);
  });
});

describe('turning extracted cards into saved items', () => {
  const card = (overrides: Record<string, unknown> = {}) => ({
    kind: 'announcement' as const,
    title: 'Midterm moved',
    course: 'Biology 101',
    detail: 'Now on Thursday.',
    date: 'Mar 5, 2026',
    sourceUrl: courseUrl,
    ...overrides,
  });

  it('keeps the wording, the source link, and a date it can place', () => {
    expect(childItemsFrom([card()], 'announcements', courseUrl)).toEqual([
      {
        title: 'Midterm moved',
        body: 'Now on Thursday.',
        dateValue: '2026-03-05',
        dateText: 'Mar 5, 2026',
        url: courseUrl,
      },
    ]);
  });

  it('ignores cards for the other collection', () => {
    expect(
      childItemsFrom(
        [card({ kind: 'assignment' })],
        'announcements',
        courseUrl,
      ),
    ).toEqual([]);
  });

  it('ignores a card whose source is not the page that was read', () => {
    expect(
      childItemsFrom(
        [card({ sourceUrl: 'https://evil.example/x' })],
        'announcements',
        courseUrl,
      ),
    ).toEqual([]);
  });

  it('ignores a card with no title and keeps a date it cannot place', () => {
    expect(
      childItemsFrom([card({ title: '  ' })], 'announcements', courseUrl),
    ).toEqual([]);
    expect(
      childItemsFrom([card({ date: 'soon' })], 'announcements', courseUrl)[0],
    ).toMatchObject({ dateValue: null, dateText: 'soon' });
  });

  it('keeps one item per distinct title on the same page', () => {
    expect(
      childItemsFrom(
        [card(), card({ detail: 'Room changed' })],
        'announcements',
        courseUrl,
      ),
    ).toHaveLength(1);
  });
});

beforeEach(() => configureBrowserPolicy(['new']));

it('recognizes course updates as the announcement collection', () => {
  expect(
    childPageTarget(
      page({ links: [link('Updates', `${courseUrl}/updates`)] }),
      'announcements',
      host,
    ),
  ).toBe(`${courseUrl}/updates`);
});
