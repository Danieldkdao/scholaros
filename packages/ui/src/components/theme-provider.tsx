'use client';

import type { ReactNode } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

type ThemeProviderProps = { children: ReactNode; clientOnly?: boolean };

export const ThemeProvider = ({
  children,
  clientOnly = false,
}: ThemeProviderProps) => (
  <NextThemesProvider
    attribute="class"
    defaultTheme="system"
    enableSystem
    storageKey="scholaros-theme"
    disableTransitionOnChange
    // The initialization script is for SSR; Electron applies its theme through effects.
    scriptProps={clientOnly ? { type: 'text/plain' } : undefined}
  >
    {children}
  </NextThemesProvider>
);
