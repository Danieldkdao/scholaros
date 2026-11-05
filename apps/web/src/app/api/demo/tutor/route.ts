import { generateDemoTutor } from '@scholaros/services/ai/demo-tutor';
import {
  createDemoTutorHandler,
  demoTutorOptions,
} from '@/lib/demo-tutor-handler';

export const runtime = 'nodejs';
export const OPTIONS = demoTutorOptions;
export const POST = createDemoTutorHandler({
  enabled: () =>
    process.env.DEMO_API_ENABLED === '1' && Boolean(process.env.META_API_KEY),
  generate: (action, signal) =>
    generateDemoTutor({
      action,
      signal,
      apiKey: process.env.META_API_KEY!,
      logging: process.env.META_DEMO_LOGGING === '1',
    }),
});
