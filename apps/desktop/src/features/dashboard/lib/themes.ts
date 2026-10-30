export const themes = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof themes)[number];

// next-themes reports the stored value as a plain string until it has mounted.
export const themePreference = (theme: string | undefined): ThemePreference =>
  themes.find((option) => option === theme) ?? 'system';
