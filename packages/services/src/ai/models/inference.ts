import { serverEnv, type InferenceProvider } from '@scholaros/env/server';
import type { LanguageModel } from 'ai';
import { baseten } from './baseten';
import { meta } from './meta';

const providers = {
  baseten: {
    isConfigured: () => !!serverEnv.BASETEN_API_KEY,
    createModel: () => baseten(serverEnv.BASETEN_MODEL),
  },
  meta: {
    isConfigured: () => !!serverEnv.META_API_KEY,
    createModel: () => meta.chat(serverEnv.META_MODEL),
  },
} satisfies Record<
  InferenceProvider,
  {
    isConfigured: () => boolean;
    createModel: () => LanguageModel;
  }
>;

export const isInferenceConfigured = () =>
  providers[serverEnv.INFERENCE_PROVIDER].isConfigured();

export const getInferenceModel = () => {
  if (!isInferenceConfigured())
    throw new Error('The inference provider is not configured.');
  return providers[serverEnv.INFERENCE_PROVIDER].createModel();
};

// These budgets include hidden reasoning as well as the structured answer.
export const reasoningBudgetTokens = 4_000;
export const evidenceBudgetTokens = 6_000;
