import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export type DesktopRuntimeEnv = {
  MODE: string;
  DEV: boolean;
  PROD: boolean;
};

// The renderer supplies Vite values; this package never reads a browser's process.env.
export const createDesktopEnv = (runtimeEnv: DesktopRuntimeEnv) =>
  createEnv({
    clientPrefix: 'VITE_',
    client: {},
    shared: {
      MODE: z.string().min(1),
      DEV: z.boolean(),
      PROD: z.boolean(),
    },
    runtimeEnvStrict: {
      MODE: runtimeEnv.MODE,
      DEV: runtimeEnv.DEV,
      PROD: runtimeEnv.PROD,
    },
    isServer: false,
    emptyStringAsUndefined: true,
  });
