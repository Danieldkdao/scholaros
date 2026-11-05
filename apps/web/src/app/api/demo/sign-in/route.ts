import { auth } from '@scholaros/auth/server';
import { serverEnv } from '@/data/env/server';
import { createDemoSignInHandler } from '@/lib/auth/demo-sign-in';

export const runtime = 'nodejs';
export const POST = createDemoSignInHandler({
  enabled: serverEnv.DEMO_AUTH_ENABLED === '1',
  email: serverEnv.DEMO_ACCOUNT_EMAIL,
  password: serverEnv.DEMO_ACCOUNT_PASSWORD,
  trustedOrigin: new URL(serverEnv.BETTER_AUTH_URL).origin,
  signIn: (input) =>
    auth.api.signInEmail({
      body: {
        email: input.email,
        password: input.password,
        callbackURL: input.callbackURL,
      },
      query: input.desktopQuery ?? undefined,
      headers: input.headers,
      asResponse: true,
    }),
});
