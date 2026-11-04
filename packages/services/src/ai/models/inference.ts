import { serverEnv, type InferenceProvider } from '@scholaros/env/server';
import type { LanguageModel } from 'ai';
import { getModelCapabilities } from '../model-capabilities';
import { baseten } from './baseten';
import { meta } from './meta';

export {
  getModelCapabilities,
  isModelCapabilityAvailable,
  ModelCapabilityUnavailableError,
  requireModelCapability,
} from '../model-capabilities';
export type {
  ModelCapabilities,
  ModelCapabilityOperation,
} from '../model-capabilities';

const providers = {
  baseten: {
    createModel: () => baseten(serverEnv.BASETEN_MODEL),
  },
  meta: {
    createModel: () => meta.chat(serverEnv.META_MODEL),
  },
} satisfies Record<
  InferenceProvider,
  {
    createModel: () => LanguageModel;
  }
>;

export const isInferenceConfigured = () => {
  const capabilities = getModelCapabilities();
  return (
    capabilities.endpointCategory === 'meta-standard' &&
    Object.values(capabilities.operations).some(Boolean)
  );
};

export const getInferenceModel = () => {
  if (!isInferenceConfigured())
    throw new Error('The inference provider is not configured.');
  return providers[serverEnv.INFERENCE_PROVIDER].createModel();
};

// These budgets include hidden reasoning as well as the structured answer.
export const reasoningBudgetTokens = 4_000;
export const evidenceBudgetTokens = 6_000;
