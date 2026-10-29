// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '../../onboarding/types';

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    invalidate: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { DashboardScreen } = await import('../dashboard-screen');

const readyState = () =>
  ({
    accountId: 'student-a',
    settings: {
      step: 'review',
      consent: true,
      launchAtLogin: false,
      backgroundSync: true,
      notes: '',
      localSetupCompletedAt: '2026-10-28T12:00:00.000Z',
    },
    workspace: {
      browser: 'chrome',
      browserName: 'Google Chrome',
      ready: true,
      status: 'ready',
      verifiedAt: '2026-10-28T12:00:00.000Z',
    },
    connections: [
      {
        id: 'connection-a',
        name: 'Canvas',
        url: 'https://canvas.school.edu/courses',
        host: 'canvas.school.edu',
        kind: 'canvas',
        status: 'confirmed',
        verifiedAt: '2026-10-28T12:00:00.000Z',
      },
    ],
    primaryLms: 'connection-a',
    discovery: {
      status: 'complete',
      message: '1 course entry point found across 1 resource.',
      discoveredAt: '2026-10-28T12:00:00.000Z',
      coverage: { 'connection-a': 'courses' },
      entries: [],
    },
    preferences: {
      launchAtLogin: { requested: false, applied: true, message: null },
      backgroundSync: {
        status: 'waiting',
        message: 'Waiting for the next scheduled sync.',
        lastSyncedAt: '2026-10-28T12:00:00.000Z',
      },
    },
  }) as unknown as OnboardingState;

const bridge = {
  getState: vi.fn(),
  getCurrentUser: vi.fn(),
  saveSettings: vi.fn(),
  pauseBackgroundSync: vi.fn(),
  resumeBackgroundSync: vi.fn(),
  onBackgroundSyncChange: vi.fn(() => () => undefined),
} as unknown as typeof window.scholar;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  bridge.getState = vi.fn(async () => readyState());
  bridge.getCurrentUser = vi.fn(async () => ({
    id: 'student-a',
    name: 'Student',
    email: 'student@example.com',
    hasCompletedOnboarding: true,
  }));
  bridge.saveSettings = vi.fn(async () => readyState());
  bridge.pauseBackgroundSync = vi.fn(async () => readyState());
  bridge.resumeBackgroundSync = vi.fn(async () => readyState());
  bridge.onBackgroundSyncChange = vi.fn(() => () => undefined);
  window.scholar = bridge;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const render = async () => {
  await act(async () => {
    root?.render(createElement(DashboardScreen));
  });
};

const clickButton = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label),
  );
  expect(button, `missing a "${label}" control`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('dashboard preferences', () => {
  it('keeps launch at login revocable after setup', async () => {
    await render();
    expect(container.querySelector('#launch-at-login')).toBeTruthy();
    expect(container.textContent).toContain('Launch ScholarOS when I sign in');
  });

  it('keeps background AI work revocable after setup', async () => {
    await render();
    expect(container.querySelector('#background-sync')).toBeTruthy();
    expect(container.textContent).toContain(
      'Sync course information in the background',
    );
  });

  it('saves a preference change without leaving the dashboard', async () => {
    await render();
    await clickButton('Pause background sync');
    expect(bridge.pauseBackgroundSync).toHaveBeenCalledOnce();
  });

  it('persists a switched preference immediately', async () => {
    await render();
    const toggle = container.querySelector('#launch-at-login')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(bridge.saveSettings).toHaveBeenCalledWith({ launchAtLogin: true });
  });

  it.each(['browser-missing', 'profile-missing'] as const)(
    'keeps preferences revocable when the workspace is %s',
    async (status) => {
      const state = readyState();
      state.settings.launchAtLogin = true;
      state.workspace = { ...state.workspace!, ready: false, status };
      bridge.getState = vi.fn(async () => state);
      await render();
      expect(container.querySelector('#background-sync')).toBeTruthy();
      const toggle = container.querySelector('#launch-at-login');
      expect(toggle).toBeTruthy();
      await act(async () => {
        toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(bridge.saveSettings).toHaveBeenCalledWith({
        launchAtLogin: false,
      });
    },
  );

  it('keeps sync pausable while the study browser needs repair', async () => {
    const state = readyState();
    state.workspace = {
      ...state.workspace!,
      ready: false,
      status: 'profile-missing',
    };
    bridge.getState = vi.fn(async () => state);
    await render();
    await clickButton('Pause background sync');
    expect(bridge.pauseBackgroundSync).toHaveBeenCalledOnce();
  });
});
