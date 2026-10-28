import { createDesktopEnv } from '@scholaros/env/desktop';

export const clientEnv = createDesktopEnv({
  MODE: import.meta.env.MODE,
  DEV: import.meta.env.DEV,
  PROD: import.meta.env.PROD,
});
