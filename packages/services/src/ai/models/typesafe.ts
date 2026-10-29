import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { serverEnv } from '@scholaros/env/server';

export const typeSafe = createTypeSafeAi({
  apiKey: serverEnv.TYPESAFE_API_KEY ?? '',
  baseURL: 'https://api.typesafe.ai/v1',
});
