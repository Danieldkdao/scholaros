import { createHash } from 'node:crypto';
import { serverEnv, type InferenceProvider } from '@scholaros/env/server';

export const metaStandardModelValues = [
  'muse-spark-1.1',
  'muse-spark-1.2',
  'muse-spark-1.3',
] as const;
export type MetaStandardModel = (typeof metaStandardModelValues)[number];

export const basetenMetaModelValues = ['meta-models/muse-spark-open'] as const;
export type BasetenMetaModel = (typeof basetenMetaModelValues)[number];

export const modelCapabilityOperationValues = [
  'connection-resolution',
  'decision-navigation',
  'course-discovery',
  'resource-extraction',
  'browser-navigation',
  'browser-extraction',
  'learning-text',
  'learning-activity',
  'learning-practice',
  'learning-memory',
  'material-image',
  'material-pdf',
] as const;
export type ModelCapabilityOperation =
  (typeof modelCapabilityOperationValues)[number];

export type ModelCapabilities = {
  version: 1;
  configurationRevision: string;
  endpointCategory:
    | 'meta-standard'
    | 'baseten-structured-output-unavailable'
    | 'unsupported';
  operations: Record<ModelCapabilityOperation, boolean>;
};

export class ModelCapabilityUnavailableError extends Error {
  constructor(operation: ModelCapabilityOperation) {
    super(`The ${operation} model capability is unavailable.`);
    this.name = 'ModelCapabilityUnavailableError';
  }
}

const isMetaStandardModel = (model: string): model is MetaStandardModel =>
  metaStandardModelValues.some((allowedModel) => allowedModel === model);

const isBasetenMetaModel = (model: string): model is BasetenMetaModel =>
  basetenMetaModelValues.some((allowedModel) => allowedModel === model);

const createOperations = (available: boolean) =>
  ({
    'connection-resolution': available,
    'decision-navigation': available,
    'course-discovery': available,
    'resource-extraction': available,
    'browser-navigation': available,
    'browser-extraction': available,
    'learning-text': available,
    'learning-activity': available,
    'learning-practice': available,
    'learning-memory': available,
    'material-image': available,
    'material-pdf': available,
  }) satisfies Record<ModelCapabilityOperation, boolean>;

export const getModelCapabilities = (): ModelCapabilities => {
  const provider: InferenceProvider = serverEnv.INFERENCE_PROVIDER;
  const model =
    provider === 'meta' ? serverEnv.META_MODEL : serverEnv.BASETEN_MODEL;
  const keyConfigured =
    provider === 'meta'
      ? Boolean(serverEnv.META_API_KEY)
      : Boolean(serverEnv.BASETEN_API_KEY);
  const endpointCategory =
    provider === 'meta' && isMetaStandardModel(model)
      ? 'meta-standard'
      : provider === 'baseten' && isBasetenMetaModel(model)
        ? 'baseten-structured-output-unavailable'
        : 'unsupported';
  const operations = createOperations(
    endpointCategory === 'meta-standard' && keyConfigured,
  );
  const configuration = {
    version: 1,
    provider,
    model,
    keyConfigured,
    endpointCategory,
    operations,
    browserNavigationMode: serverEnv.BROWSER_NAV,
  };
  const revision = createHash('sha256')
    .update(JSON.stringify(configuration))
    .digest('hex')
    .slice(0, 24);

  return {
    version: 1,
    configurationRevision: `v1-${revision}`,
    endpointCategory,
    operations,
  };
};

export const isModelCapabilityAvailable = (
  operation: ModelCapabilityOperation,
): boolean => getModelCapabilities().operations[operation];

export const requireModelCapability = (
  operation: ModelCapabilityOperation,
): void => {
  if (!isModelCapabilityAvailable(operation))
    throw new ModelCapabilityUnavailableError(operation);
};
