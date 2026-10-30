import type { ReactNode } from 'react';
import { ThemeProvider } from '@scholaros/ui/components/theme-provider';
import { TooltipProvider } from '@scholaros/ui/components/tooltip';

type ProvidersProps = { children: ReactNode };

// Base UI tooltips fall back to a 600ms pointer-*rest* requirement when no
// provider is mounted, so a normal hover never opens them. The provider's
// zero delay is what makes the collapsed sidebar labels appear on hover.
export const Providers = ({ children }: ProvidersProps) => (
  <ThemeProvider clientOnly>
    <TooltipProvider>{children}</TooltipProvider>
  </ThemeProvider>
);
