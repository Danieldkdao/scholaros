import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

const Page = () => (
  <Suspense>
    <AuthForm signup />
  </Suspense>
);

export default Page;
