// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealCourseNavigation } from '../services/page-content';

type PageStub = { evaluate: (fn: () => string) => Promise<string> };

const load = (markup: string) => {
  document.body.innerHTML = markup;
  const clicked: string[] = [];
  for (const element of document.querySelectorAll<HTMLButtonElement>('button'))
    element.addEventListener('click', () => {
      clicked.push(element.textContent ?? '');
    });
  const page: PageStub = {
    evaluate: async (fn) => fn(),
  };
  return { page, clicked };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('navigation disclosure', () => {
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

  it('never clicks a link or a non-navigation button', async () => {
    const spy = vi.fn();
    const { page, clicked } = load(
      '<div><button aria-expanded="false">Courses</button><a href="/courses">Courses list</a></div>',
    );
    document.querySelector('a')?.addEventListener('click', () => void spy());
    await revealCourseNavigation(
      page as unknown as Parameters<typeof revealCourseNavigation>[0],
    );
    expect(clicked).toEqual([]);
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
