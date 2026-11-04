import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  configureBrowserPolicy: vi.fn(),
  setIntervalSeconds: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    once: vi.fn(),
    on: vi.fn(),
  },
}));
vi.mock('../lib/browser-policy', () => ({
  configureBrowserPolicy: mocks.configureBrowserPolicy,
}));
vi.mock('../services/mission-traffic', () => ({
  missionTraffic: { setIntervalSeconds: mocks.setIntervalSeconds },
}));

mocks.userData = mkdtempSync(path.join(tmpdir(), 'scholaros-offline-state-'));
const { db } = await import('../../../db');
const { AcademicContextTable, SettingTable } =
  await import('../../../db/schema');
const { eq } = await import('drizzle-orm');
const { getOnboardingState } = await import('../services/store');

const userId = 'offline-student';

beforeEach(() => {
  db.delete(SettingTable).where(eq(SettingTable.userId, userId)).run();
  db.delete(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .run();
  mocks.configureBrowserPolicy.mockClear();
  mocks.setIntervalSeconds.mockClear();
});

afterAll(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

it('does not initialize missing onboarding rows during an offline state read', () => {
  expect(() => getOnboardingState(userId, { readOnly: true })).toThrow(
    'Saved offline onboarding state is unavailable.',
  );
  expect(
    db.select().from(SettingTable).where(eq(SettingTable.userId, userId)).get(),
  ).toBeUndefined();
  expect(
    db
      .select()
      .from(AcademicContextTable)
      .where(eq(AcademicContextTable.userId, userId))
      .get(),
  ).toBeUndefined();
});

it('does not persist normalization or change browser policy while reading offline state', () => {
  db.insert(SettingTable)
    .values({
      userId,
      decisionTimeSeconds: 99,
      updatedAt: new Date().toISOString(),
    })
    .run();
  db.insert(AcademicContextTable).values({ userId }).run();

  const state = getOnboardingState(userId, { readOnly: true });

  expect(state.settings.decisionTimeSeconds).toBe(5);
  expect(
    db.select().from(SettingTable).where(eq(SettingTable.userId, userId)).get()
      ?.decisionTimeSeconds,
  ).toBe(99);
  expect(mocks.configureBrowserPolicy).not.toHaveBeenCalled();
  expect(mocks.setIntervalSeconds).not.toHaveBeenCalled();
});
