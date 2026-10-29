import { describe, expect, it, vi } from 'vitest';
import {
  exploreForCourses,
  type ExplorationFixtures,
} from '../lib/course-exploration';
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
  ...overrides,
});

const link = (label: string, path: string) => ({
  label,
  url: `https://${schoology}${path}`,
});

const homePage = {
  url: `https://${schoology}/`,
  title: 'Home',
  links: [link('Grades', '/grades'), link('Courses', '/courses')],
};

const listPage = {
  url: `https://${schoology}/courses`,
  title: 'Courses',
  links: [
    link('Biology 101', '/course/12345'),
    { ...link('World History B', '/course/67890'), context: 'Current course' },
    link('Help', '/help'),
  ],
};

const fixtures = (overrides: Partial<ExplorationFixtures> = {}) => {
  const read = vi.fn(async () => homePage);
  const navigate = vi.fn(async () => undefined);
  const disclose = vi.fn(async () => 'not-found' as const);
  return {
    read,
    navigate,
    disclose,
    isCurrent: () => true,
    signal: new AbortController().signal,
    ...overrides,
    connection: connection(),
  };
};

const sequenceRead = (pages: Array<typeof homePage>) => {
  let index = 0;
  return vi.fn(async () => {
    const page = pages[Math.min(index, pages.length - 1)]!;
    index += 1;
    return page;
  });
};

describe('bounded course exploration', () => {
  it('stops without navigating when the connected page already lists courses', async () => {
    const result = await exploreForCourses(
      fixtures({
        read: sequenceRead([listPage]),
        navigate: vi.fn(async () => undefined),
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    expect(result.status).toBe('courses');
    expect(
      result.entries.filter((entry) => entry.role === 'course'),
    ).toHaveLength(2);
    expect(result.visited).toEqual([`https://${schoology}/courses`]);
  });

  it('steps from a home page to the observed course list', async () => {
    const navigate = vi.fn(async () => undefined);
    const result = await exploreForCourses(
      fixtures({
        read: sequenceRead([homePage, listPage]),
        navigate,
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    expect(navigate).toHaveBeenCalledWith(`https://${schoology}/courses`);
    expect(result.status).toBe('courses');
    expect(result.visited).toEqual([
      `https://${schoology}/`,
      `https://${schoology}/courses`,
    ]);
  });

  it('records provenance from the page where each entry was observed', async () => {
    const result = await exploreForCourses(
      fixtures({
        read: sequenceRead([homePage, listPage]),
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    const biology = result.entries.find(
      (entry) => entry.label === 'Biology 101',
    );
    expect(biology).toMatchObject({
      connectionId: 'connection-schoology',
      role: 'course',
      evidenceUrl: `https://${schoology}/courses`,
    });
  });

  it('re-observes after a navigation disclosure opens', async () => {
    // No course-list link is exposed until the collapsed nav control is opened.
    const collapsedHome = {
      url: `https://${schoology}/`,
      title: 'Home',
      links: [link('Grades', '/grades'), link('Calendar', '/calendar')],
    };
    const revealedHome = {
      ...collapsedHome,
      links: [...collapsedHome.links, link('Biology 101', '/course/12345')],
    };
    const result = await exploreForCourses(
      fixtures({
        read: sequenceRead([collapsedHome, revealedHome]),
        disclose: vi.fn(async () => 'opened' as const),
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    expect(result.disclosed).toBe(true);
    expect(result.status).toBe('courses');
    expect(result.visited).toEqual([`https://${schoology}/`]);
  });

  it('only ever navigates to a destination the page exposed', async () => {
    const navigate = vi.fn(async () => undefined);
    await exploreForCourses(
      fixtures({
        read: sequenceRead([
          {
            url: `https://${schoology}/`,
            title: 'Home',
            links: [link('Help', '/help')],
          },
        ]),
        navigate,
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('respects the page budget', async () => {
    const looping = {
      url: `https://${schoology}/`,
      title: 'Home',
      links: [link('Courses', '/courses')],
    };
    const listWithNoCourses = {
      url: `https://${schoology}/courses`,
      title: 'Courses',
      text: 'You have no courses.',
      links: [],
    };
    const read = sequenceRead([looping, listWithNoCourses]);
    const result = await exploreForCourses(
      fixtures({
        read,
        navigate: vi.fn(async () => undefined),
        maxPages: 3,
      }) as unknown as Parameters<typeof exploreForCourses>[0],
    );
    expect(read.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.status).toBe('empty');
  });

  it('separates a readable empty list from an inconclusive page', async () => {
    const emptyList = {
      url: `https://${schoology}/courses`,
      title: 'Courses',
      text: 'You have no courses.',
      links: [],
    };
    const opaque = {
      url: `https://${schoology}/landing`,
      title: 'Welcome',
      links: [link('Learn more', '/about')],
    };
    expect(
      (
        await exploreForCourses(
          fixtures({
            read: sequenceRead([emptyList]),
          }) as unknown as Parameters<typeof exploreForCourses>[0],
        )
      ).status,
    ).toBe('empty');
    expect(
      (
        await exploreForCourses(
          fixtures({
            read: sequenceRead([opaque]),
          }) as unknown as Parameters<typeof exploreForCourses>[0],
        )
      ).status,
    ).toBe('inconclusive');
  });

  it('stops immediately when the mission is cancelled', async () => {
    const controller = new AbortController();
    const navigate = vi.fn(async () => undefined);
    controller.abort();
    await expect(
      exploreForCourses(
        fixtures({
          read: sequenceRead([homePage, listPage]),
          navigate,
          signal: controller.signal,
        }) as unknown as Parameters<typeof exploreForCourses>[0],
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops when the account session changed', async () => {
    await expect(
      exploreForCourses(
        fixtures({
          read: sequenceRead([homePage, listPage]),
          isCurrent: () => false,
        }) as unknown as Parameters<typeof exploreForCourses>[0],
      ),
    ).rejects.toThrow('Your session changed');
  });

  it('does not loop when a navigation lands on a page already seen', async () => {
    const read = sequenceRead([
      {
        url: `https://${schoology}/`,
        title: 'Home',
        links: [link('Courses', '/courses')],
      },
      {
        url: `https://${schoology}/`,
        title: 'Home',
        links: [link('Courses', '/courses')],
      },
    ]);
    const navigate = vi.fn(async () => undefined);
    const result = await exploreForCourses(
      fixtures({ read, navigate }) as unknown as Parameters<
        typeof exploreForCourses
      >[0],
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(result.visited).toEqual([`https://${schoology}/`]);
  });
});

it('does not treat a Courses title alone as proof of an empty list', async () => {
  const result = await exploreForCourses(
    fixtures({
      read: vi.fn(async () => ({ ...homePage, title: 'Courses', links: [] })),
    }),
  );
  expect(result.status).toBe('inconclusive');
});
it('checks cancellation after observation before navigation', async () => {
  const controller = new AbortController();
  const navigate = vi.fn(async () => undefined);
  await expect(
    exploreForCourses(
      fixtures({
        signal: controller.signal,
        navigate,
        read: vi.fn(async () => {
          controller.abort();
          return homePage;
        }),
      }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(navigate).not.toHaveBeenCalled();
});
it('does not navigate at the end of the observation budget', async () => {
  const navigate = vi.fn(async () => undefined);
  await exploreForCourses(fixtures({ navigate, maxPages: 1 }));
  expect(navigate).not.toHaveBeenCalled();
});

it('uses semantic recognition only for destinations actually observed', async () => {
  const observed = {
    ...homePage,
    text: 'My classes include World History B',
    links: [link('World History B', '/section?view=9')],
  };
  const result = await exploreForCourses({
    ...fixtures({ read: vi.fn(async () => observed) }),
    classify: async () => [
      `https://${schoology}/section?view=9`,
      `https://${schoology}/invented`,
    ],
  });
  expect(
    result.entries
      .filter((entry) => entry.role === 'course')
      .map((entry) => entry.url),
  ).toEqual([`https://${schoology}/section?view=9`]);
});

it('does not mistake an empty catalog search for no enrolled courses', async () => {
  const observed = {
    ...homePage,
    title: 'Courses',
    text: 'No courses found for this search.',
    links: [],
  };
  expect(
    (await exploreForCourses(fixtures({ read: vi.fn(async () => observed) })))
      .status,
  ).toBe('inconclusive');
});
