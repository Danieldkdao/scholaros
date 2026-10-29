import { createBaseten } from '@ai-sdk/baseten';
import { serverEnv } from '@scholaros/env/server';

export const baseten = createBaseten({
  apiKey: serverEnv.BASETEN_API_KEY ?? '',
});
