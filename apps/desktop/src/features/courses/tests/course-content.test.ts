import { configureBrowserPolicy } from '../../onboarding/lib/browser-policy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  childPageTarget,
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

it('offers supporting links only from authorized sources and preserves the observed retrieval context', async () => {
  const { resourceRequest } = await import('../lib/resource-content');
  const retrievedAt = '2026-10-31T23:59:00Z';
  const request = resourceRequest({
    page: {
      ...page({
        links: [
          link('Notes', 'https://docs.google.com/document/d/1'),
          link('Unconnected', 'https://unconnected.example/notes'),
        ],
      }),
      retrievedAt,
      locale: 'en-US',
    },
    kind: 'assignments',
    goal: 'Read work',
    notes: '',
    host,
    allowedHosts: [host, 'docs.google.com'],
    courseUrl,
    courseName: 'Biology',
  });
  expect(request.targets?.map((target) => target.url)).toEqual([
    'https://docs.google.com/document/d/1',
  ]);
  expect(request.context).toMatchObject({
    retrievedAt,
    locale: 'en-US',
    observedTimezone: null,
  });
});
