import { Suspense } from 'react';
import { DesktopCallback } from '@/components/auth/desktop-callback';

const Page = () => (
  <Suspense>
    <DesktopCallback />
  </Suspense>
);

export default Page;
