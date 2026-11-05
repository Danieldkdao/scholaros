import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { createMetaDemoFetch } from './models/meta-demo-logger';

export type DemoTutorAction = 'explain' | 'quiz' | 'experiment';
const demoExperimentSchema = z.strictObject({
  kind: z.literal('osmosis'),
  title: z.string().trim().min(1).max(80),
  introduction: z.string().trim().min(1).max(280),
  insideConcentration: z.number().int().min(0).max(10),
  outsideConcentration: z.number().int().min(0).max(10),
  predictionQuestion: z.string().trim().min(1).max(180),
});
export type DemoExperimentSchema = z.infer<typeof demoExperimentSchema>;
export type DemoTutorResult = {
  text: string;
  model: string;
  experiment?: DemoExperimentSchema;
};
export const demoTutorModel = 'muse-spark-1.3';
const samplePrompts: Record<DemoTutorAction, string> = {
  experiment:
    'Configure one original synthetic Biology osmosis scenario. Choose inside and outside solute concentrations as integers from 0 to 10, preferably unequal. Give it a short title, a brief neutral introduction, and one question asking the learner to predict the net direction of water movement. Do not reveal the correct direction, outcome, rule, or answer in the introduction or question. The trusted app supplies all controls, simulation calculations, answer choices and reveal behavior. This is a conceptual demonstration, not coursework or a measured biological model.',
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
}): Promise<DemoTutorResult> => {
  const isExperiment = input.action === 'experiment';
  const provider = createOpenAI({
    baseURL: 'https://api.meta.ai/v1',
    apiKey: input.apiKey,
    fetch: createMetaDemoFetch({ enabled: () => input.logging }),
  });
  const result = await generateText({
    model: provider.chat(demoTutorModel),
    instructions: isExperiment
      ? 'Return only the requested bounded experiment configuration. No HTML or JavaScript, tools, links, personal information, or claims of access to real student accounts. Do not give away the scenario answer before the learner predicts.'
      : 'You are a concise educational tutor demonstrating ScholarOS. Follow only the fixed sample task. Return readable text, never HTML, executable tools, links, requests for personal information, or claims of access to real student accounts.',
    prompt: samplePrompts[input.action],
    output: isExperiment
      ? Output.object({ schema: demoExperimentSchema })
      : undefined,
    reasoning: 'low',
    maxOutputTokens: isExperiment ? 2048 : 1024,
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
  if (isExperiment) {
    const experiment = demoExperimentSchema.parse(result.output);
    return { text: experiment.introduction, model: demoTutorModel, experiment };
  }
  if (!result.text.trim()) throw new Error('The demo response is empty.');
  return { text: result.text.slice(0, 8000), model: demoTutorModel };
};
