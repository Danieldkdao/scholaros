import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@scholaros/ui/styles.css';

export const metadata: Metadata = {
  title: 'ScholarOS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
