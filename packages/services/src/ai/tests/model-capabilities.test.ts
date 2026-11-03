import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  INFERENCE_PROVIDER: 'meta' as 'meta' | 'baseten',
  META_API_KEY: 'test-meta-secret' as string | undefined,
  META_MODEL: 'muse-spark-1.3',
  BASETEN_API_KEY: 'test-baseten-secret' as string | undefined,
  BASETEN_MODEL: 'meta-models/muse-spark-open-1026',
  BROWSER_NAV: 'decision' as 'decision' | 'inout',
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv: env }));

import {
  getModelCapabilities,
  isModelCapabilityAvailable,
} from '../model-capabilities';

beforeEach(() => {
  env.INFERENCE_PROVIDER = 'meta';
  env.META_API_KEY = 'test-meta-secret';
  env.META_MODEL = 'muse-spark-1.3';
  env.BASETEN_API_KEY = 'test-baseten-secret';
  env.BASETEN_MODEL = 'meta-models/muse-spark-open-1026';
  env.BROWSER_NAV = 'decision';
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

  it('rejects Contributor and non-Meta model IDs even with configured keys', () => {
    env.META_MODEL = 'muse-spark-1.3-contributor';
    expect(getModelCapabilities().endpointCategory).toBe('unsupported');
    expect(isModelCapabilityAvailable('decision-navigation')).toBe(false);

    env.META_MODEL = 'gpt-4o';
    expect(isModelCapabilityAvailable('learning-text')).toBe(false);
  });

  it('preserves the unverified Baseten token and reports its structured capabilities unavailable', () => {
    env.INFERENCE_PROVIDER = 'baseten';
    const capabilities = getModelCapabilities();

    expect(capabilities.endpointCategory).toBe('unsupported');
    expect(capabilities.operations['resource-extraction']).toBe(false);
    expect(capabilities.operations['material-pdf']).toBe(false);
    expect(capabilities.configurationRevision).toMatch(/^v1-[a-f0-9]{24}$/);
  });

  it('does not infer structured-output support from the documented Spark Open alias', () => {
    env.INFERENCE_PROVIDER = 'baseten';
    env.BASETEN_MODEL = 'meta-models/muse-spark-open';

    expect(getModelCapabilities().endpointCategory).toBe(
      'baseten-structured-output-unavailable',
    );
    expect(isModelCapabilityAvailable('browser-extraction')).toBe(false);
    expect(isModelCapabilityAvailable('learning-text')).toBe(false);
  });

  it('marks a missing selected-provider key unavailable without falling back', () => {
    env.META_API_KEY = undefined;
    const capabilities = getModelCapabilities();

    expect(capabilities.endpointCategory).toBe('meta-standard');
    expect(capabilities.operations['decision-navigation']).toBe(false);
    expect(capabilities.configurationRevision).not.toContain(
      'test-meta-secret',
    );
  });

  it('changes the safe configuration revision without exposing secrets or endpoints', () => {
    const first = getModelCapabilities();
    env.META_API_KEY = 'rotated-meta-secret';
    const second = getModelCapabilities();
    env.META_MODEL = 'muse-spark-1.3-contributor';
    const third = getModelCapabilities();
    env.BROWSER_NAV = 'inout';
    const fourth = getModelCapabilities();

    expect(second.configurationRevision).toBe(first.configurationRevision);
    expect(third.configurationRevision).not.toBe(first.configurationRevision);
    expect(fourth.configurationRevision).not.toBe(third.configurationRevision);
    const serialized = JSON.stringify(fourth);
    expect(serialized).not.toContain('rotated-meta-secret');
    expect(serialized).not.toContain('api.meta.ai');
    expect(serialized).not.toContain('inference.baseten.co');
  });
});
