import { createDesktopEnv } from '@scholaros/env/desktop';

export const clientEnv = createDesktopEnv({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  MODE: import.meta.env.MODE,
  DEV: import.meta.env.DEV,
  PROD: import.meta.env.PROD,
});
