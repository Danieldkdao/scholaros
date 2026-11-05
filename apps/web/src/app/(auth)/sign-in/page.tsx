import { serverEnv } from '@/data/env/server';
import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

const Page = () => (
  <Suspense>
    <AuthForm
      demoAccountEnabled={
        serverEnv.DEMO_AUTH_ENABLED === '1' &&
        Boolean(serverEnv.DEMO_ACCOUNT_EMAIL && serverEnv.DEMO_ACCOUNT_PASSWORD)
      }
    />
  </Suspense>
);

export default Page;
