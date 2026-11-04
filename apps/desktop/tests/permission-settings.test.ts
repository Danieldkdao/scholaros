import { expect, it, vi } from 'vitest';
import { openSystemPermissionSettings } from '../src/lib/permission-settings';

it('opens only fixed macOS settings destinations for explicit permission actions', async () => {
  const openExternal = vi.fn(async (_url: string) => undefined);
  await openSystemPermissionSettings('microphone', 'darwin', openExternal);
  await openSystemPermissionSettings('notifications', 'darwin', openExternal);
  expect(openExternal.mock.calls).toEqual([
    [
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    ],
    ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'],
  ]);
});

it('does not open macOS destinations on another platform', async () => {
  const openExternal = vi.fn(async (_url: string) => undefined);
  await openSystemPermissionSettings('microphone', 'win32', openExternal);
  expect(openExternal).not.toHaveBeenCalled();
});
