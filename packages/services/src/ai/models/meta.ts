import { createOpenAI } from '@ai-sdk/openai';
import { serverEnv } from '@scholaros/env/server';

export const meta = createOpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey: serverEnv.META_API_KEY ?? '',
});
