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
const watchEligibleState = {
  ...state,
  settings: {
    ...state.settings,
    localSetupCompletedAt: null,
  },
  workspace: {
    browser: 'chrome',
    browserName: 'Google Chrome',
    ready: true,
    status: 'ready',
    verifiedAt: new Date().toISOString(),
  },
  connections: [
    {
      id: 'canvas-connection',
      name: 'Canvas',
      host: 'canvas.school.edu',
      url: 'https://canvas.school.edu/courses',
      status: 'verified',
      isCourseResource: true,
    },
  ],
} as unknown as OnboardingState;

const mount = async (
  section: SettingsSection | 'watch',
  leafSettings = {},
  localDataActions: {
    deleteLocalData?: (input: { requestId: string }) => Promise<void>;
    onLocalDataDeleted?: () => void;
  } = {},
  onboardingState = state,
) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ProductSettings, {
        accountId: onboardingState.accountId,
        state: onboardingState,
        section,
        watchSettings,
        watchRuntime,
        onSettingsSave: vi.fn(async () => undefined),
        onWatchSave: vi.fn(async (settings: WatchSettings) => settings),
        onStateChange: vi.fn(),
        deleteLocalData: localDataActions.deleteLocalData,
        onLocalDataDeleted: localDataActions.onLocalDataDeleted,
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

it('requires local setup before enabling watch with an otherwise eligible connection', async () => {
  const { container, root } = await mount(
    'background',
    {},
    {},
    watchEligibleState,
  );
  const watchSwitch = container.querySelector('#watch-course-pages-switch')!;

  expect(container.textContent).toContain(
    'Finish this computer’s setup to enable watching.',
  );
  expect((watchSwitch as HTMLButtonElement).disabled).toBe(true);

  await act(async () => root.unmount());
});

const click = async (element: Element) =>
  act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

it('keeps local data removal gated until the product adapter is available', async () => {
  const { container, root } = await mount('local-data');
  const reviewButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('Review local data removal'),
  )!;

  expect(reviewButton.disabled).toBe(true);
  expect(container.textContent).toContain(
    'Local data removal is unavailable until the product adapter is connected.',
  );
  expect(
    document.body.querySelector('[data-slot="alert-dialog-action"]'),
  ).toBeNull();
  await act(async () => root.unmount());
});

it('requires confirmation and reports deletion success only after the host resolves', async () => {
  const deleteLocalData = vi
    .fn<(input: { requestId: string }) => Promise<void>>()
    .mockRejectedValueOnce(new Error('device service offline'))
    .mockResolvedValueOnce(undefined);
  const onDeleted = vi.fn();
  const { container, root } = await mount(
    'local-data',
    {},
    {
      deleteLocalData,
      onLocalDataDeleted: onDeleted,
    },
  );
  const reviewButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('Review local data removal'),
  )!;

  await click(reviewButton);
  expect(deleteLocalData).not.toHaveBeenCalled();
  expect(
    document.body.querySelector('[data-slot="alert-dialog-action"]'),
  ).toBeTruthy();
  const confirmButton = document.body.querySelector(
    '[data-slot="alert-dialog-action"]',
  )!;
  await click(confirmButton);
  await vi.waitFor(() => expect(deleteLocalData).toHaveBeenCalledOnce());
  expect(deleteLocalData).toHaveBeenCalledWith({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
  });
  expect(onDeleted).not.toHaveBeenCalled();
  expect(container.textContent).toContain('device service offline');

  await click(confirmButton);
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(deleteLocalData).toHaveBeenCalledTimes(2);

  await act(async () => root.unmount());
});
