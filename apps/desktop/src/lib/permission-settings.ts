/** Fixed destinations only: renderer-controlled URLs must never reach the shell. */
export const openSystemPermissionSettings = async (
  permission: 'microphone' | 'notifications',
  platform: NodeJS.Platform,
  openExternal: (url: string) => Promise<void>,
) => {
  if (platform !== 'darwin') return;
  await openExternal(
    permission === 'microphone'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      : 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  );
};
