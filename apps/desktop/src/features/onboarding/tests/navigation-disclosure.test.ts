// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealCourseNavigation } from '../services/page-content';

type PageStub = {
  evaluate: (fn: (scope: string) => string, scope: string) => Promise<string>;
  locator: (selector: string) => { click: () => Promise<void> };
  waitForLoadState: (state: string, timeout: number) => Promise<void>;
};

const load = (markup: string) => {
  document.body.innerHTML = markup;
  const clicked: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(
    'button, [role="button"], a',
  ))
    element.addEventListener('click', () => {
      clicked.push(element.textContent ?? '');
    });
  const page: PageStub = {
    waitForLoadState: vi.fn(async () => undefined),
    evaluate: async (fn, scope) => fn(scope),
    locator: (selector: string) => ({
      click: async () => {
        document.querySelector<HTMLElement>(selector)!.click();
      },
    }),
  };
  return { page, clicked };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('navigation disclosure', () => {
  it('waits for course-menu data requests before returning the opened menu', async () => {
    const { page } = load('<nav><button>Courses</button></nav>');
    await revealCourseNavigation(page as never);
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', 6000);
  });
  it('opens a legacy course menu represented by a hash link in the header', async () => {
    const { page, clicked } = load('<header><a href="#">Courses</a></header>');
    expect(await revealCourseNavigation(page as never)).toBe('opened');
    expect(clicked).toEqual(['Courses']);
  });
  it('opens a course disclosure implemented as a link-shaped button in the page header', async () => {
    const { page, clicked } = load(
      '<header><a role="button" href="#courses" aria-expanded="false" aria-controls="courses">Courses</a></header>',
    );
    expect(await revealCourseNavigation(page as never)).toBe('opened');
    expect(clicked).toEqual(['Courses']);
  });

  it('uses a browser input click for course menus', async () => {
    const { page } = load(
      '<nav><button aria-expanded="false">Courses</button></nav>',
    );
    const click = vi.fn(async () => undefined);
    await revealCourseNavigation({
      ...page,
      locator: vi.fn(() => ({ click })),
    } as never);
    expect(click).toHaveBeenCalledOnce();
  });

  it('opens a collapsed course control inside the site navigation', async () => {
    const { page, clicked } = load(
      '<nav><button aria-expanded="false" aria-controls="courses">Courses</button></nav>',
    );
    expect(
      await revealCourseNavigation(
        page as unknown as Parameters<typeof revealCourseNavigation>[0],
      ),
    ).toBe('opened');
    expect(clicked).toEqual(['Courses']);
  });

  it('does not open a control that is already expanded', async () => {
    const { page, clicked } = load(
      '<nav><button aria-expanded="true">Courses</button></nav>',
    );
    await revealCourseNavigation(
      page as unknown as Parameters<typeof revealCourseNavigation>[0],
    );
    expect(clicked).toEqual([]);
  });

  it('refuses a control that could submit a form', async () => {
    const { page, clicked } = load(
      '<nav><form><button type="submit" aria-expanded="false">Courses</button></form></nav>',
    );
    expect(
      await revealCourseNavigation(
        page as unknown as Parameters<typeof revealCourseNavigation>[0],
      ),
    ).toBe('refused');
    expect(clicked).toEqual([]);
  });

  it('refuses an action control that only looks like navigation', async () => {
    const { page, clicked } = load(
      '<nav><button aria-expanded="false" data-action="delete-section">Courses</button></nav>',
    );
    expect(
      await revealCourseNavigation(
        page as unknown as Parameters<typeof revealCourseNavigation>[0],
      ),
    ).toBe('refused');
    expect(clicked).toEqual([]);
  });

  it('reports not found when no course control exists', async () => {
    const { page } = load(
      '<nav><button aria-expanded="false">Announcements</button></nav>',
    );
    expect(
      await revealCourseNavigation(
        page as unknown as Parameters<typeof revealCourseNavigation>[0],
      ),
    ).toBe('not-found');
  });

  it('opens an explicit course button outside semantic landmarks without following nearby links', async () => {
    const spy = vi.fn();
    const { page, clicked } = load(
      '<div><button aria-expanded="false">Courses</button><a href="/courses">Courses list</a></div>',
    );
    document.querySelector('a')?.addEventListener('click', () => void spy());
    await revealCourseNavigation(
      page as unknown as Parameters<typeof revealCourseNavigation>[0],
    );
    expect(clicked).toEqual(['Courses']);
    expect(spy).not.toHaveBeenCalled();
  });
});

it('refuses an externally form-associated disclosure button', async () => {
  const { page, clicked } = load(
    '<form id="outside"></form><nav><button form="outside" aria-expanded="false">Courses</button></nav>',
  );
  expect(
    await revealCourseNavigation(
      page as unknown as Parameters<typeof revealCourseNavigation>[0],
    ),
  ).toBe('refused');
  expect(clicked).toEqual([]);
});

it('opens content tabs and collapsed modules while refusing submission controls', async () => {
  for (const label of [
    'Assignments',
    'Announcements',
    'Modules',
    'Load more',
  ]) {
    const { page, clicked } = load(`<button type="button">${label}</button>`);
    expect(await revealCourseNavigation(page as never, 'content')).toBe(
      'opened',
    );
    expect(clicked).toEqual([label]);
  }
  const { page, clicked } = load(
    '<form><button type="submit">Assignments</button></form><button>Submit assignment</button>',
  );
  expect(await revealCourseNavigation(page as never, 'content')).toBe(
    'refused',
  );
  expect(clicked).toEqual([]);
});
