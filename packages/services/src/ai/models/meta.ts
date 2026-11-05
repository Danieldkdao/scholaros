import { createOpenAI } from '@ai-sdk/openai';
import { serverEnv } from '@scholaros/env/server';
import { createMetaDemoFetch } from './meta-demo-logger';

export const meta = createOpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey: serverEnv.META_API_KEY ?? '',
  fetch: createMetaDemoFetch({
    enabled: () => serverEnv.META_DEMO_LOGGING === '1',
  }),
});
