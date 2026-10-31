import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-recapture-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
  };
});
const peek = vi.hoisted(() => vi.fn(async (_userId: string) => null));
vi.mock('../services/browser-workspace', () => ({
  getAcademicPage: async () => ({
    evaluate: async () => ({
      origin: 'https://school.edu',
      host: 'school.edu',
      pathname: '/courses',
      href: 'https://school.edu/courses',
      title: 'Courses',
      hasPasswordField: false,
      hasCanvasMarkers: true,
      courseLinkCount: 1,
    }),
  }),
  peekAcademicPage: (userId: string) => peek(userId),
}));
const iconMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => null),
);
vi.mock('../services/site-icons', () => ({ fetchSiteIcon: iconMock }));
const { db } = await import('../../../db');
const { AcademicConnectionTable } = await import('../../../db/schema');
const { captureResource, saveConnectionNotes } =
  await import('../services/connections');
it('preserves saved notes when the same resource is captured again', async () => {
  db.insert(AcademicConnectionTable)
    .values({
      id: 'a',
      userId: 'student',
      name: 'School',
      host: 'school.edu',
      url: 'https://school.edu/',
      kind: 'canvas',
      status: 'confirmed',
      notes: 'Lab portal',
    })
    .run();
  const result = await captureResource('student');
  expect(result.notes).toBe('Lab portal');
  expect(
    saveConnectionNotes('student', 'a', 'updated').connections[0]?.notes,
  ).toBe('updated');
});

it('captures the specific inspected page rather than whichever tab is active', async () => {
  const { captureResourcePage } = await import('../services/connections');
  const page = {
    evaluate: vi.fn(async () => ({
      origin: 'https://other.edu',
      host: 'other.edu',
      pathname: '/',
      href: 'https://other.edu/',
      title: 'Other',
      hasPasswordField: false,
      hasCanvasMarkers: false,
      courseLinkCount: 0,
    })),
  };
  const result = await captureResourcePage(
    'student',
    page as never,
    () => true,
  );
  expect(result.host).toBe('other.edu');
  expect(page.evaluate).toHaveBeenCalledOnce();
});

it('refuses capture if an inspected tab has moved to a different host', async () => {
  const { captureResourcePage } = await import('../services/connections');
  const page = {
    evaluate: vi.fn(async () => ({
      origin: 'https://other.edu',
      host: 'other.edu',
      pathname: '/',
      href: 'https://other.edu/',
      title: 'Other',
      hasPasswordField: false,
      hasCanvasMarkers: false,
      courseLinkCount: 0,
    })),
  };
  await expect(
    captureResourcePage('student', page as never, () => true, 'school.edu'),
  ).rejects.toThrow();
});

it('stores the site icon declared by the captured page', async () => {
  const { captureResourcePage } = await import('../services/connections');
  const page = {
    evaluate: vi.fn(async () => ({
      origin: 'https://icons.edu',
      host: 'icons.edu',
      pathname: '/',
      href: 'https://icons.edu/',
      title: 'Icons',
      hasPasswordField: false,
      hasCanvasMarkers: false,
      courseLinkCount: 0,
      icon: 'https://icons.edu/brand.png',
    })),
  };
  iconMock.mockResolvedValueOnce('data:image/png;base64,icon');

  const result = await captureResourcePage(
    'student',
    page as never,
    () => true,
  );

  expect(iconMock).toHaveBeenCalledWith(
    'icons.edu',
    'https://icons.edu/brand.png',
  );
  expect(result.favicon).toBe('data:image/png;base64,icon');
  const stored = db
    .select()
    .from(AcademicConnectionTable)
    .where(eq(AcademicConnectionTable.host, 'icons.edu'))
    .get();
  expect(stored?.favicon).toBe('data:image/png;base64,icon');
});

it('still connects the site when no icon can be read', async () => {
  const { captureResourcePage } = await import('../services/connections');
  const page = {
    evaluate: vi.fn(async () => ({
      origin: 'https://noicon.edu',
      host: 'noicon.edu',
      pathname: '/',
      href: 'https://noicon.edu/',
      title: 'No icon',
      hasPasswordField: false,
      hasCanvasMarkers: false,
      courseLinkCount: 0,
      icon: null,
    })),
  };

  const result = await captureResourcePage(
    'student',
    page as never,
    () => true,
  );

  expect(result.favicon).toBeNull();
});

const openPage = (overrides: Record<string, unknown> = {}) => ({
  evaluate: async () => ({
    origin: 'https://preview.edu',
    host: 'preview.edu',
    pathname: '/',
    href: 'https://preview.edu/',
    title: 'Preview Home',
    hasPasswordField: false,
    hasCanvasMarkers: false,
    courseLinkCount: 0,
    icon: null,
    ...overrides,
  }),
});

it('previews the open page without storing a connection', async () => {
  const { previewResource } = await import('../services/connections');
  const before = db.select().from(AcademicConnectionTable).all().length;
  peek.mockResolvedValueOnce(openPage() as never);

  const result = await previewResource('student');

  expect(result).toMatchObject({
    name: 'Preview Home',
    host: 'preview.edu',
    kind: 'resource',
  });
  expect(db.select().from(AcademicConnectionTable).all()).toHaveLength(before);
});

it('previews nothing while the study browser is closed', async () => {
  const { previewResource } = await import('../services/connections');
  peek.mockResolvedValueOnce(null);

  await expect(previewResource('student')).resolves.toBeNull();
});

it('previews nothing when the open page is not connectable', async () => {
  const { previewResource } = await import('../services/connections');
  peek.mockResolvedValueOnce(
    openPage({ hasPasswordField: true, title: 'Log in' }) as never,
  );

  await expect(previewResource('student')).resolves.toBeNull();
});

it('does not overwrite notes edited while a recapture is fetching the icon', async () => {
  let release!: (icon: string | null) => void;
  iconMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = captureResource('student');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  saveConnectionNotes('student', 'a', 'Latest note');
  release(null);
  await pending;
  expect(
    db
      .select()
      .from(AcademicConnectionTable)
      .where(eq(AcademicConnectionTable.id, 'a'))
      .get()?.notes,
  ).toBe('Latest note');
});
