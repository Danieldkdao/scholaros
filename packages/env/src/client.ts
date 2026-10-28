import { createEnv } from '@t3-oss/env-core';

// Add NEXT_PUBLIC_ schemas and explicit process.env mappings together.
export const clientEnv = createEnv({
  clientPrefix: 'NEXT_PUBLIC_',
  client: {},
  runtimeEnvStrict: {},
  emptyStringAsUndefined: true,
});
