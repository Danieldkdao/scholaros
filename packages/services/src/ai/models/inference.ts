import { serverEnv } from '@scholaros/env/server';
import { getModelCapabilities } from '../model-capabilities';
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

export const isInferenceConfigured = () => {
  const capabilities = getModelCapabilities();
  return (
    capabilities.endpointCategory === 'meta-standard' &&
    Object.values(capabilities.operations).some(Boolean)
  );
};

export const getInferenceModel = () => {
  if (!isInferenceConfigured())
    throw new Error('Meta inference is unavailable for the configured model.');
  return meta.chat(serverEnv.META_MODEL);
};

// These budgets include hidden reasoning as well as the structured answer.
export const reasoningBudgetTokens = 4_000;
export const evidenceBudgetTokens = 6_000;
