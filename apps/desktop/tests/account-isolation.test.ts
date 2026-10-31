import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-store-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { db } = await import('../src/db');
const { AcademicConnectionTable, AcademicContextTable, SettingTable } =
  await import('../src/db/schema');
const { getOnboardingState, removeAcademicConnection, saveOnboardingSettings } =
  await import('../src/features/onboarding/services/store');
const { confirmResource, setPrimaryLms, saveConnectionNotes } =
  await import('../src/features/onboarding/services/connections');

const studentA = 'student-a';
const studentB = 'student-b';

const insertConnection = (
  userId: string,
  id: string,
  overrides: Partial<typeof AcademicConnectionTable.$inferInsert> = {},
) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: `${userId} resource`,
      url: 'https://canvas.school.edu/courses',
      host: `${userId}.school.edu`,
      kind: 'canvas',
      status: 'needs-sign-in',
      verifiedAt: null,
      ...overrides,
    })
    .run();

beforeEach(() => {
  db.delete(AcademicConnectionTable).run();
  db.delete(AcademicContextTable).run();
  db.delete(SettingTable).run();
});

describe('account isolation on one computer', () => {
  it('keeps onboarding settings separate for each account', () => {
    saveOnboardingSettings(studentA, {
      consent: true,
      step: 'preferences',
      notes: 'Biology lab meets on Thursdays.',
      launchAtLogin: true,
    });
    const accountA = getOnboardingState(studentA);
    const accountB = getOnboardingState(studentB);
    expect(accountA.settings).toMatchObject({
      consent: true,
      step: 'preferences',
      notes: 'Biology lab meets on Thursdays.',
      launchAtLogin: true,
    });
    expect(accountB.settings).toMatchObject({
      consent: false,
      step: 'welcome',
      notes: '',
      launchAtLogin: false,
    });
  });

  it('lists only the active account connections', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentB, 'connection-b');
    expect(
      getOnboardingState(studentA).connections.map((item) => item.id),
    ).toEqual(['connection-a']);
    expect(
      getOnboardingState(studentB).connections.map((item) => item.id),
    ).toEqual(['connection-b']);
  });

  it('cannot remove or promote another account connection', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentB, 'connection-b');
    removeAcademicConnection(studentA, 'connection-b');
    expect(
      getOnboardingState(studentB).connections.map((item) => item.id),
    ).toEqual(['connection-b']);
    expect(() => setPrimaryLms(studentA, 'connection-b')).toThrow(
      'Choose a connected resource.',
    );
  });

  it('cannot confirm another account connection', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentB, 'connection-b');
    confirmResource(studentA, 'connection-b');
    expect(getOnboardingState(studentB).connections[0]?.status).toBe(
      'needs-sign-in',
    );
  });
  it('saves notes only for the owning account and rejects oversized input', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentB, 'connection-b');
    expect(
      saveConnectionNotes(studentA, 'connection-a', '  Biology  ')
        .connections[0]?.notes,
    ).toBe('Biology');
    saveConnectionNotes(studentA, 'connection-b', 'wrong account');
    expect(getOnboardingState(studentB).connections[0]?.notes).toBeNull();
    expect(() =>
      saveConnectionNotes(studentA, 'connection-a', 'x'.repeat(501)),
    ).toThrow();
    expect(
      saveConnectionNotes(studentA, 'connection-a', '').connections[0]?.notes,
    ).toBe('');
  });
});
