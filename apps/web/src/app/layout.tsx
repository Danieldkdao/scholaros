import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@scholaros/ui/styles.css';
import { Toaster } from '@scholaros/ui/components/toast';

export const metadata: Metadata = {
  title: 'ScholarOS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
