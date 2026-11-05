import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { createMetaDemoFetch } from './models/meta-demo-logger';

export type DemoTutorAction = 'explain' | 'quiz';
export const demoTutorModel = 'muse-spark-1.3';
const samplePrompts: Record<DemoTutorAction, string> = {
  explain:
    'Explain how a Python for loop visits the items in the fictional list [2, 4, 6]. Keep the explanation under 180 words. This is a standalone conceptual demonstration with synthetic data, not coursework. Include one small code example and a question that checks understanding.',
  quiz: 'Create a short, original three-question beginner quiz about Python for loops. Use only fictional lists and simple examples. Put questions first and a concise answer key after them. Keep the whole quiz under 220 words. This is a standalone demonstration, not schoolwork.',
};

/** Anonymous demonstration with fixed synthetic prompts, isolated from account services. */
export const generateDemoTutor = async (input: {
  action: DemoTutorAction;
  apiKey: string;
  logging: boolean;
  signal: AbortSignal;
}) => {
  const provider = createOpenAI({
    baseURL: 'https://api.meta.ai/v1',
    apiKey: input.apiKey,
    fetch: createMetaDemoFetch({ enabled: () => input.logging }),
  });
  const result = await generateText({
    model: provider.chat(demoTutorModel),
    instructions:
      'You are a concise educational tutor demonstrating ScholarOS. Follow only the fixed sample task. Return readable text, never HTML, executable tools, links, requests for personal information, or claims of access to real student accounts.',
    prompt: samplePrompts[input.action],
    reasoning: 'low',
    maxOutputTokens: 1024,
    maxRetries: 0,
    abortSignal: input.signal,
    providerOptions: {
      openai: {
        forceReasoning: true,
        systemMessageMode: 'developer',
        store: false,
      },
    },
    telemetry: { isEnabled: false },
  });
  input.signal.throwIfAborted();
  if (!result.text.trim()) throw new Error('The demo response is empty.');
  return { text: result.text.slice(0, 8000), model: demoTutorModel };
};
