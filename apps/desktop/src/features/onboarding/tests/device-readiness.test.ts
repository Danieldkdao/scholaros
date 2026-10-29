import { beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-readiness-'));
  testPaths.userData = userData;
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { existsSync, mkdirSync, rmSync, writeFileSync } =
  await import('node:fs');
const { join } = await import('node:path');
const { db } = await import('../../../db');
const { AcademicContextTable, BrowserWorkspaceTable, SettingTable } =
  await import('../../../db/schema');
const { getOnboardingState, saveOnboardingSettings, settleLocalSetup } =
  await import('../services/store');
const { profileDirectoryFor } = await import('../lib/profile-directory');

const userId = 'student-a';
const executable = () => join(testPaths.userData, 'chrome');

const saveWorkspace = (verifiedAt: string | null = new Date().toISOString()) =>
  db
    .insert(BrowserWorkspaceTable)
    .values({
      userId,
      browser: 'chrome',
      browserName: 'Google Chrome',
      executable: executable(),
      verifiedAt: verifiedAt ?? '',
    })
    .onConflictDoUpdate({
      target: BrowserWorkspaceTable.userId,
      set: { executable: executable(), verifiedAt: verifiedAt ?? '' },
    })
    .run();

beforeEach(() => {
  db.delete(BrowserWorkspaceTable).run();
  db.delete(SettingTable).run();
  db.delete(AcademicContextTable).run();
  rmSync(executable(), { force: true });
  rmSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
    recursive: true,
    force: true,
  });
});

describe('device readiness', () => {
  it('reports a missing dedicated profile even when the browser is installed', () => {
    writeFileSync(executable(), '');
    saveWorkspace();

    const state = getOnboardingState(userId);
    expect(state.workspace).toMatchObject({
      ready: false,
      status: 'profile-missing',
    });
  });

  it('is ready after provisioning without requiring the browser to stay open', () => {
    writeFileSync(executable(), '');
    mkdirSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
    });
    saveWorkspace();

    const state = getOnboardingState(userId);
    expect(state.workspace).toMatchObject({ ready: true, status: 'ready' });
  });

  it('detects a browser that was removed after setup', () => {
    mkdirSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
    });
    saveWorkspace();

    const state = getOnboardingState(userId);
    expect(state.workspace).toMatchObject({
      ready: false,
      status: 'browser-missing',
    });
  });

  it('does not claim readiness before a successful connection check', () => {
    writeFileSync(executable(), '');
    mkdirSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
    });
    saveWorkspace(null);

    const state = getOnboardingState(userId);
    expect(state.workspace).toMatchObject({
      ready: false,
      status: 'unverified',
    });
  });

  it('recovers after the profile is provisioned again', () => {
    writeFileSync(executable(), '');
    saveWorkspace();
    expect(getOnboardingState(userId).workspace?.status).toBe(
      'profile-missing',
    );

    mkdirSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
    });
    expect(getOnboardingState(userId).workspace?.status).toBe('ready');
    expect(
      existsSync(profileDirectoryFor(testPaths.userData, userId, executable())),
    ).toBe(true);
  });
});

describe('local setup completion', () => {
  const provisionWorkspace = () => {
    writeFileSync(executable(), '');
    mkdirSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
    });
    saveWorkspace();
  };

  it('records completion when a finished account sets up this computer', () => {
    provisionWorkspace();
    const consented = saveOnboardingSettings(userId, { consent: true });
    expect(consented.settings.localSetupCompletedAt).toBeNull();

    const settled = settleLocalSetup(consented, { accountCompleted: true });

    expect(settled.settings.localSetupCompletedAt).not.toBeNull();
    expect(
      getOnboardingState(userId).settings.localSetupCompletedAt,
    ).not.toBeNull();
  });

  it('leaves an account that is still onboarding to finish it explicitly', () => {
    provisionWorkspace();
    const consented = saveOnboardingSettings(userId, { consent: true });

    expect(
      settleLocalSetup(consented, { accountCompleted: false }).settings
        .localSetupCompletedAt,
    ).toBeNull();
  });

  it('waits for consent and a verified study browser', () => {
    provisionWorkspace();
    expect(
      settleLocalSetup(getOnboardingState(userId), { accountCompleted: true })
        .settings.localSetupCompletedAt,
    ).toBeNull();

    saveOnboardingSettings(userId, { consent: true });
    rmSync(profileDirectoryFor(testPaths.userData, userId, executable()), {
      recursive: true,
      force: true,
    });
    expect(
      settleLocalSetup(getOnboardingState(userId), { accountCompleted: true })
        .settings.localSetupCompletedAt,
    ).toBeNull();
  });

  it('keeps the first completion time', () => {
    provisionWorkspace();
    const consented = saveOnboardingSettings(userId, { consent: true });
    const firstCompletedAt = settleLocalSetup(consented, {
      accountCompleted: true,
    }).settings.localSetupCompletedAt;

    const secondCompletedAt = settleLocalSetup(getOnboardingState(userId), {
      accountCompleted: true,
    }).settings.localSetupCompletedAt;

    expect(secondCompletedAt).toBe(firstCompletedAt);
  });
});
