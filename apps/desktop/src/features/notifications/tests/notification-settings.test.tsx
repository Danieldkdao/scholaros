// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { NotificationSettings as NotificationSettingsValue } from '@scholaros/services/learning/notification-contracts';
import {
  getSettingsSaveState,
  retrySettingsSave,
} from '../../dashboard/settings-save-queue';
import { NotificationSettings } from '../components/notification-settings';
import { createDefaultNotificationSettings } from '../services/notification-policy';
import type { NotificationPermission } from '../services/notification-policy';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mount = async (
  settings = createDefaultNotificationSettings(),
  onSave = vi.fn(async (next: NotificationSettingsValue) => ({
    ...next,
    revision: next.revision + 1,
  })),
  requestPermission: () => Promise<NotificationPermission> = vi.fn(
    async () => 'granted' as const,
  ),
  permissionState?: 'granted' | 'denied' | 'unsupported' | 'unknown',
  accountId = `notification-settings-${crypto.randomUUID()}`,
) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(NotificationSettings, {
        accountId,
        settings,
        onSave,
        requestPermission,
        permissionState,
      }),
    ),
  );
  return { container, root, onSave, requestPermission };
};

const click = async (element: Element) =>
  act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

const changeInput = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

it('does not request native permission when the settings leaf is opened', async () => {
  const { root, requestPermission } = await mount();

  expect(requestPermission).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('requests permission only when the master switch is explicitly enabled', async () => {
  const save = vi.fn(async (next: NotificationSettingsValue) => ({
    ...next,
    revision: next.revision + 1,
  }));
  const requestPermission = vi.fn(async () => 'granted' as const);
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    requestPermission,
  );

  await click(container.querySelector('[aria-label="Enable notifications"]')!);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

  expect(requestPermission).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  await act(async () => root.unmount());
});

it('keeps notifications off and explains system settings after permission denial', async () => {
  const save = vi.fn(async (next: NotificationSettingsValue) => ({
    ...next,
    revision: next.revision + 1,
  }));
  const requestPermission = vi.fn(async () => 'denied' as const);
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    requestPermission,
  );

  await click(container.querySelector('[aria-label="Enable notifications"]')!);

  expect(requestPermission).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'Allow notifications in system settings',
  );
  expect(
    container
      .querySelector('[aria-label="Enable notifications"]')
      ?.getAttribute('aria-checked'),
  ).toBe('false');
  await act(async () => root.unmount());
});

it('autosaves event categories while the master switch remains off', async () => {
  const save = vi.fn(async (next: NotificationSettingsValue) => ({
    ...next,
    revision: next.revision + 1,
  }));
  const requestPermission = vi.fn(async () => 'granted' as const);
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    requestPermission,
  );

  await click(container.querySelector('[aria-label="Sync completed"]')!);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

  expect(requestPermission).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: false,
      categories: expect.objectContaining({ 'sync-completed': true }),
    }),
  );
  await act(async () => root.unmount());
});

it('uses full-width time inputs and persists quiet-hour edits automatically', async () => {
  const settings = {
    ...createDefaultNotificationSettings(),
    quietHours: {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 8 * 60,
      timeZone: 'UTC',
    },
  };
  const save = vi.fn(async (next: NotificationSettingsValue) => ({
    ...next,
    revision: next.revision + 1,
  }));
  const { container, root } = await mount(settings, save);
  const startTime = container.querySelector<HTMLInputElement>(
    '[aria-label="Start quiet hours"]',
  )!;

  await changeInput(startTime, '21:30');
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

  expect(startTime.className).toContain('w-full');
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      quietHours: expect.objectContaining({ startMinute: 21 * 60 + 30 }),
    }),
  );
  expect(container.querySelector('button[type="submit"]')).toBeNull();
  await act(async () => root.unmount());
});

it('serializes notification edits with the latest saved revision', async () => {
  const accountId = `notification-revision-${crypto.randomUUID()}`;
  const pending: Array<{
    settings: NotificationSettingsValue;
    resolve: (saved: NotificationSettingsValue) => void;
  }> = [];
  const save = vi.fn(
    (settings: NotificationSettingsValue) =>
      new Promise<NotificationSettingsValue>((resolve) => {
        pending.push({ settings, resolve });
      }),
  );
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    undefined,
    undefined,
    accountId,
  );

  await click(container.querySelector('[aria-label="Sync completed"]')!);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await click(container.querySelector('[aria-label="Sync failed"]')!);
  expect(pending).toHaveLength(1);

  await act(async () =>
    pending[0]!.resolve({ ...pending[0]!.settings, revision: 1 }),
  );
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[1]!.settings.revision).toBe(1);
  expect(pending[1]!.settings.categories).toMatchObject({
    'sync-completed': true,
    'sync-failed': true,
  });

  await act(async () =>
    pending[1]!.resolve({ ...pending[1]!.settings, revision: 2 }),
  );
  await act(async () => root.unmount());
});

it('persists the latest notification edits while an earlier save is pending', async () => {
  const accountId = `notification-pending-draft-${crypto.randomUUID()}`;
  const pending: Array<{
    settings: NotificationSettingsValue;
    resolve: (saved: NotificationSettingsValue) => void;
  }> = [];
  const save = vi.fn(
    (settings: NotificationSettingsValue) =>
      new Promise<NotificationSettingsValue>((resolve) => {
        pending.push({ settings, resolve });
      }),
  );
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    undefined,
    undefined,
    accountId,
  );

  await click(container.querySelector('[aria-label="Sync completed"]')!);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await click(container.querySelector('[aria-label="Sync failed"]')!);

  expect(
    getSettingsSaveState(accountId).draft.notificationSettings?.categories,
  ).toMatchObject({
    'sync-completed': true,
    'sync-failed': true,
  });

  await act(async () =>
    pending[0]!.resolve({ ...pending[0]!.settings, revision: 1 }),
  );
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () =>
    pending[1]!.resolve({ ...pending[1]!.settings, revision: 2 }),
  );
  await act(async () => root.unmount());
});

it('restores and retries a failed notification draft after the leaf remounts', async () => {
  const accountId = `notification-retry-${crypto.randomUUID()}`;
  const save = vi
    .fn<
      (
        settings: NotificationSettingsValue,
      ) => Promise<NotificationSettingsValue>
    >()
    .mockRejectedValueOnce(new Error('notification service offline'))
    .mockImplementation(async (settings) => ({
      ...settings,
      revision: settings.revision + 1,
    }));
  const first = await mount(
    createDefaultNotificationSettings(),
    save,
    undefined,
    undefined,
    accountId,
  );

  await click(first.container.querySelector('[aria-label="Sync completed"]')!);
  await vi.waitFor(() =>
    expect(getSettingsSaveState(accountId).groups.notifications?.error).toBe(
      'notification service offline',
    ),
  );
  await act(async () => first.root.unmount());

  const reopened = await mount(
    createDefaultNotificationSettings(),
    save,
    undefined,
    undefined,
    accountId,
  );
  expect(
    reopened.container
      .querySelector('[aria-label="Sync completed"]')
      ?.getAttribute('aria-checked'),
  ).toBe('true');
  await act(async () => {
    await retrySettingsSave(accountId, 'notifications');
  });
  expect(save).toHaveBeenCalledTimes(2);
  expect(
    getSettingsSaveState(accountId).groups.notifications?.error,
  ).toBeNull();

  await act(async () => reopened.root.unmount());
});

it('keeps pending notification edits retryable when the account changes mid-save', async () => {
  const accountId = `notification-account-fence-${crypto.randomUUID()}`;
  const pending: Array<{
    settings: NotificationSettingsValue;
    resolve: (saved: NotificationSettingsValue) => void;
  }> = [];
  const save = vi.fn(
    (settings: NotificationSettingsValue) =>
      new Promise<NotificationSettingsValue>((resolve) => {
        pending.push({ settings, resolve });
      }),
  );
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    save,
    undefined,
    undefined,
    accountId,
  );

  await click(container.querySelector('[aria-label="Sync completed"]')!);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await act(async () =>
    root.render(
      createElement(NotificationSettings, {
        accountId: `${accountId}-other`,
        settings: createDefaultNotificationSettings(),
        onSave: save,
        requestPermission: async () => 'unknown' as const,
      }),
    ),
  );
  await act(async () =>
    pending[0]!.resolve({ ...pending[0]!.settings, revision: 1 }),
  );

  await vi.waitFor(() =>
    expect(
      getSettingsSaveState(accountId).groups.notifications?.error,
    ).toContain('Your session changed'),
  );
  expect(
    getSettingsSaveState(accountId).draft.notificationSettings?.categories,
  ).toMatchObject({ 'sync-completed': true });

  await act(async () => root.unmount());
});

it('shows denied permission status without requesting it on mount', async () => {
  const requestPermission = vi.fn(async () => 'denied' as const);
  const { container, root } = await mount(
    createDefaultNotificationSettings(),
    undefined,
    requestPermission,
    'denied',
  );

  expect(requestPermission).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'Allow notifications in system settings',
  );
  await act(async () => root.unmount());
});
