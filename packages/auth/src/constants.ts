export const desktopScheme = 'ai.scholaros.desktop';

export const authProviders = ['google', 'github'] as const;
export type AuthProvider = (typeof authProviders)[number];

export const desktopClientId = 'electron';
export const desktopCallbackPath = '/auth/desktop';
