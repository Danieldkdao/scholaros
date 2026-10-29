import { sendVerificationOtp } from '@scholaros/services/mailjet/emails/verification-emails';
import { electron } from '@better-auth/electron';
import { serverEnv } from '@scholaros/env/server';
import type { BetterAuthOptions } from 'better-auth';
import { desktopScheme } from './constants';
import { emailOTP } from 'better-auth/plugins';

export const authOptions = {
  appName: 'ScholarOS',
  baseURL: serverEnv.BETTER_AUTH_URL,
  secret: serverEnv.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    requireEmailVerification: true,
  },
  emailVerification: {
    autoSignInAfterVerification: true,
    sendOnSignUp: true,
    sendOnSignIn: true,
  },
  user: {
    additionalFields: {
      hasCompletedOnboarding: {
        type: 'boolean',
        defaultValue: false,
        input: false,
      },
    },
  },
  advanced: {
    database: {
      generateId: 'uuid',
    },
  },
  socialProviders: {
    google: {
      clientId: serverEnv.GOOGLE_CLIENT_ID,
      clientSecret: serverEnv.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: serverEnv.GITHUB_CLIENT_ID,
      clientSecret: serverEnv.GITHUB_CLIENT_SECRET,
    },
  },
  trustedOrigins: [serverEnv.BETTER_AUTH_URL, `${desktopScheme}:/`],
  session: {
    cookieCache: { enabled: false },
  },
  plugins: [
    electron(),
    emailOTP({
      overrideDefaultEmailVerification: true,
      expiresIn: 15 * 60,
      changeEmail: {
        enabled: true,
      },
      sendVerificationOTP: async (data) => {
        await sendVerificationOtp(data);
      },
    }),
  ],
} satisfies BetterAuthOptions;
