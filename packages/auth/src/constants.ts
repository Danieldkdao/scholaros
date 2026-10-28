export const desktopScheme = 'ai.scholaros.desktop';

export const authProviders = ['google', 'github', 'facebook'] as const;
export type AuthProvider = (typeof authProviders)[number];
