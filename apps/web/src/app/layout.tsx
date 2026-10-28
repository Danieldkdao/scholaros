import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@scholaros/ui/styles.css';
import { ThemeProvider } from '@scholaros/ui/components/theme-provider';
import { Toaster } from '@scholaros/ui/components/toast';

export const metadata: Metadata = {
  title: 'ScholarOS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <Toaster>{children}</Toaster>
        </ThemeProvider>
      </body>
    </html>
  );
}
