import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env, metaChat } = vi.hoisted(() => ({
  env: {
    META_API_KEY: 'test-meta-secret' as string | undefined,
    META_MODEL: 'muse-spark-1.3',
    BROWSER_NAV: 'decision' as 'decision' | 'inout',
  },
  metaChat: vi.fn((model: string) => ({ id: model })),
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv: env }));
vi.mock('../models/meta', () => ({ meta: { chat: metaChat } }));

import {
  getModelCapabilities,
  isModelCapabilityAvailable,
} from '../model-capabilities';
import { getInferenceModel, isInferenceConfigured } from '../models/inference';

beforeEach(() => {
  delete (env as Record<string, unknown>).INFERENCE_PROVIDER;
  delete (env as Record<string, unknown>).BASETEN_API_KEY;
  delete (env as Record<string, unknown>).BASETEN_MODEL;
  env.META_API_KEY = 'test-meta-secret';
  env.META_MODEL = 'muse-spark-1.3';
  env.BROWSER_NAV = 'decision';
  metaChat.mockClear();
});

describe('server-owned Meta model capabilities', () => {
  it.each(['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3'] as const)(
    'enables documented operations for the exact Standard Meta model %s',
    (model) => {
      env.META_MODEL = model;
      const capabilities = getModelCapabilities();

      expect(capabilities.endpointCategory).toBe('meta-standard');
      expect(capabilities.operations['decision-navigation']).toBe(true);
      expect(capabilities.operations['browser-navigation']).toBe(true);
      expect(capabilities.operations['learning-text']).toBe(true);
      expect(capabilities.operations['material-pdf']).toBe(true);
      expect(isModelCapabilityAvailable('resource-extraction')).toBe(true);
    },
  );

  it('rejects Contributor and non-Meta model IDs without falling back', () => {
    for (const model of ['muse-spark-1.3-contributor', 'gpt-4o']) {
      env.META_MODEL = model;

      expect(getModelCapabilities().endpointCategory).toBe('unsupported');
      expect(isModelCapabilityAvailable('learning-text')).toBe(false);
      expect(isInferenceConfigured()).toBe(false);
      expect(() => getInferenceModel()).toThrow(/Meta.*unavailable/i);
    }

    expect(metaChat).not.toHaveBeenCalled();
  });

  it('marks a missing Meta key unavailable even when stale alternative settings exist', () => {
    env.META_API_KEY = undefined;
    Object.assign(env, {
      INFERENCE_PROVIDER: 'baseten',
      BASETEN_API_KEY: 'legacy-test-key',
      BASETEN_MODEL: 'meta-models/muse-spark-open',
    });

    const capabilities = getModelCapabilities();

    expect(capabilities.operations['decision-navigation']).toBe(false);
    expect(isInferenceConfigured()).toBe(false);
    expect(() => getInferenceModel()).toThrow(/Meta.*unavailable/i);
    expect(metaChat).not.toHaveBeenCalled();
  });

  it('always selects the configured Meta model and ignores stale provider selection', () => {
    Object.assign(env, {
      INFERENCE_PROVIDER: 'baseten',
      BASETEN_API_KEY: 'legacy-test-key',
      BASETEN_MODEL: 'meta-models/muse-spark-open',
    });

    expect(getModelCapabilities().endpointCategory).toBe('meta-standard');
    expect(getInferenceModel()).toEqual({ id: 'muse-spark-1.3' });
    expect(metaChat).toHaveBeenCalledExactlyOnceWith('muse-spark-1.3');
  });

  it('changes the safe revision for model or browser mode without exposing secrets', () => {
    const first = getModelCapabilities();
    env.META_API_KEY = 'rotated-meta-secret';
    const second = getModelCapabilities();
    env.META_MODEL = 'muse-spark-1.2';
    const third = getModelCapabilities();
    env.BROWSER_NAV = 'inout';
    const fourth = getModelCapabilities();

    expect(second.configurationRevision).toBe(first.configurationRevision);
    expect(third.configurationRevision).not.toBe(first.configurationRevision);
    expect(fourth.configurationRevision).not.toBe(third.configurationRevision);
    const serialized = JSON.stringify(fourth);
    expect(serialized).not.toContain('rotated-meta-secret');
    expect(serialized).not.toContain('api.meta.ai');
  });
});
