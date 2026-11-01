import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-course-resource-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
  };
});
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
  peekAcademicPage: async () => null,
}));
vi.mock('../services/site-icons', () => ({
  fetchSiteIcon: async () => null,
}));

const { db } = await import('../../../db');
const { AcademicConnectionTable, AcademicContextTable, SettingTable } =
  await import('../../../db/schema');
const { getOnboardingState } = await import('../services/store');
const { captureResource, setCourseResource } =
  await import('../services/connections');

const studentA = 'student-a';
const studentB = 'student-b';

const insertConnection = (userId: string, id: string, host: string) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: 'School',
      url: `https://${host}/courses`,
      host,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: new Date().toISOString(),
    })
    .run();

const flagFor = (userId: string, id: string) =>
  getOnboardingState(userId).connections.find((item) => item.id === id)
    ?.isCourseResource;

beforeEach(() => {
  db.delete(AcademicConnectionTable).run();
  db.delete(AcademicContextTable).run();
  db.delete(SettingTable).run();
});

describe('marking a connection as a course resource', () => {
  it('defaults to unmarked for a connection saved before the setting existed', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    expect(flagFor(studentA, 'connection-a')).toBe(false);
  });

  it('marks and unmarks a connection across state reconstruction', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    expect(
      setCourseResource(studentA, 'connection-a', true).connections[0]
        ?.isCourseResource,
    ).toBe(true);
    expect(flagFor(studentA, 'connection-a')).toBe(true);
    expect(
      setCourseResource(studentA, 'connection-a', false).connections[0]
        ?.isCourseResource,
    ).toBe(false);
    expect(flagFor(studentA, 'connection-a')).toBe(false);
  });

  it('keeps several marked connections independently marked', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    insertConnection(studentA, 'connection-b', 'portal.edu');
    setCourseResource(studentA, 'connection-a', true);
    setCourseResource(studentA, 'connection-b', true);
    setCourseResource(studentA, 'connection-b', false);
    expect(
      getOnboardingState(studentA).connections.map(
        (connection) => connection.isCourseResource,
      ),
    ).toEqual([true, false]);
  });

  it('keeps the marking when the same site is captured again', async () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    setCourseResource(studentA, 'connection-a', true);
    const recaptured = await captureResource(studentA);
    expect(recaptured.id).toBe('connection-a');
    expect(recaptured.isCourseResource).toBe(true);
  });

  it('keeps a marking made while a recapture is in flight', async () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    const pending = captureResource(studentA);
    setCourseResource(studentA, 'connection-a', true);
    await pending;
    expect(flagFor(studentA, 'connection-a')).toBe(true);
  });

  it('cannot mark another account connection', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    insertConnection(studentB, 'connection-b', 'portal.edu');
    expect(() => setCourseResource(studentA, 'connection-b', true)).toThrow(
      'Choose a connected resource.',
    );
    expect(flagFor(studentB, 'connection-b')).toBe(false);
  });

  it('rejects a connection id that no longer exists', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    expect(() => setCourseResource(studentA, 'removed', true)).toThrow(
      'Choose a connected resource.',
    );
  });

  it('stays marked when the site later needs sign-in again', () => {
    insertConnection(studentA, 'connection-a', 'school.edu');
    setCourseResource(studentA, 'connection-a', true);
    db.update(AcademicConnectionTable)
      .set({ status: 'needs-sign-in', verifiedAt: null })
      .run();
    const [connection] = getOnboardingState(studentA).connections;
    expect(connection?.status).toBe('needs-sign-in');
    expect(connection?.isCourseResource).toBe(true);
  });
});
