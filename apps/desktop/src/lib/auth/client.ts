import { electronClient } from '@better-auth/electron/client';
import { storage } from '@better-auth/electron/storage';
import { desktopScheme } from '@scholaros/auth/constants';
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';
import { clientEnv } from '../../data/env/client';

// This module belongs to the main process; renderer access goes through preload.
export const authClient = createAuthClient({
  baseURL: clientEnv.VITE_API_URL,
  plugins: [
    emailOTPClient(),
    electronClient({
      signInURL: new URL('/sign-in', clientEnv.VITE_API_URL),
      protocol: { scheme: desktopScheme },
      storage: storage({ configName: 'auth' }),
    }),
  ],
});
