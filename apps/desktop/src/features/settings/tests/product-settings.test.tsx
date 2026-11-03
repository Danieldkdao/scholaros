// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type {
  OnboardingState,
  WatchRuntimeState,
} from '../../onboarding/types';
import type { WatchSettings } from '../../watch/types';
import type { SettingsSection } from '../../../db/shared';
import { queueWatchSettingsSave } from '../../dashboard/settings-save-queue';
import { ProductSettings } from '../components/product-settings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, ...props }: Record<string, unknown>) =>
    createElement(
      'a',
      {
        href: `${to as string}${search ? `?section=${(search as { section: string }).section}` : ''}`,
        ...props,
      },
      children as string,
    ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  accountId: 'student-a',
  settings: {
    step: 'review',
    consent: true,
    launchAtLogin: false,
    backgroundSync: false,
    decisionTimeSeconds: 1,
    blockedWords: [],
    notes: '',
    localSetupCompletedAt: null,
  },
  workspace: null,
  connections: [],
  primaryLms: null,
  discovery: {
    status: 'pending',
    message: null,
    discoveredAt: null,
    coverage: {},
    entries: [],
  },
  preferences: {
    launchAtLogin: { status: 'off', message: null },
    backgroundSync: { status: 'off', message: null, lastSyncedAt: null },
  },
} as unknown as OnboardingState;

const watchSettings: WatchSettings = { watchEnabled: false, watchUrls: [] };
const watchRuntime: WatchRuntimeState = { enabled: false, status: 'off' };

const mount = async (section: SettingsSection | 'watch', leafSettings = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ProductSettings, {
        accountId: state.accountId,
        state,
        section,
        watchSettings,
        watchRuntime,
        onSettingsSave: vi.fn(async () => undefined),
        onWatchSave: vi.fn(async (settings: WatchSettings) => settings),
        onStateChange: vi.fn(),
        leafSettings,
      }),
    ),
  );
  return { container, root };
};

it('shows the complete Settings section navigation and the selected section', async () => {
  const { container, root } = await mount('account');

  expect(
    container.querySelector('[aria-label="Settings sections"]'),
  ).toBeTruthy();
  expect(
    [...container.querySelectorAll('[data-settings-section]')].map((item) =>
      item.getAttribute('data-settings-section'),
    ),
  ).toEqual([
    'account',
    'device',
    'connections',
    'personal-context',
    'ai-navigation',
    'background',
    'grades',
    'notifications',
    'appearance',
    'local-data',
  ]);
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
    'Account',
  );

  await act(async () => root.unmount());
});

it('mounts provided grade, memory and notification leaves in their sections', async () => {
  const leafSettings = {
    grades: createElement('p', null, 'Grade access leaf'),
    'personal-context': createElement('p', null, 'Memory leaf'),
    notifications: createElement('p', null, 'Notification leaf'),
  };
  for (const [section, label] of [
    ['grades', 'Grade access leaf'],
    ['personal-context', 'Memory leaf'],
    ['notifications', 'Notification leaf'],
  ] as const) {
    const { container, root } = await mount(section, leafSettings);
    expect(container.textContent).toContain(label);
    await act(async () => root.unmount());
    document.body.replaceChildren();
  }
});

it('keeps the failed group and retry action visible in the shared status sidebar', async () => {
  const accountId = `settings-retry-${crypto.randomUUID()}`;
  const watchDraft = {
    watchEnabled: true,
    watchUrls: ['https://canvas.school.edu/courses/biology'],
  };
  await expect(
    queueWatchSettingsSave(accountId, watchDraft, async () => {
      throw new Error('watch offline');
    }),
  ).rejects.toThrow('watch offline');
  const accountState = { ...state, accountId };
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ProductSettings, {
        accountId,
        state: accountState,
        section: 'background',
        watchSettings,
        watchRuntime,
        onSettingsSave: vi.fn(async () => undefined),
        onWatchSave: vi.fn(async (settings: WatchSettings) => settings),
        onStateChange: vi.fn(),
      }),
    ),
  );

  expect(
    container.querySelector('[aria-label="Settings save status"]'),
  ).toBeTruthy();
  expect(container.textContent).toContain('Watch settings');
  expect(container.textContent).toContain('watch offline');
  expect(
    container.querySelector('[aria-label="Retry watch settings"]'),
  ).toBeTruthy();

  await act(async () => root.unmount());
});

it('states when additional accessibility preferences are unavailable', async () => {
  const { container, root } = await mount('appearance');

  expect(container.textContent).toContain(
    'Text-size and contrast controls are unavailable in this build.',
  );

  await act(async () => root.unmount());
});
