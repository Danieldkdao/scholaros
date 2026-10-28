'use client';

import { electronProxyClient } from '@better-auth/electron/proxy';
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { desktopScheme } from './constants';

export const authClient = createAuthClient({
  plugins: [
    electronProxyClient({ protocol: { scheme: desktopScheme } }),
    emailOTPClient(),
  ],
});
