import { describe, expect, it, vi } from 'vitest';
import { completeOnboarding } from '../services/completion';
import type { OnboardingState } from '../types';

const readyState: OnboardingState = {
  accountId: 'student-a',
  settings: {
    step: 'review',
    consent: true,
    launchAtLogin: false,
    backgroundSync: false,
    notes: '',
    localSetupCompletedAt: null,
  },
  workspace: {
    browser: 'chrome',
    browserName: 'Google Chrome',
    ready: true,
    status: 'ready',
    verifiedAt: '2026-01-01T00:00:00.000Z',
  },
  connections: [],
  primaryLms: null,
  discovery: {
    status: 'pending',
    message: null,
    discoveredAt: null,
    coverage: {},
    entries: [],
  },
  preferences: {
    launchAtLogin: { requested: false, applied: true, message: null },
    backgroundSync: { status: 'off', message: null, lastSyncedAt: null },
  },
};

const setup = () => {
  const cancelPreview = vi.fn(async () => undefined);
  const markLocalComplete = vi.fn();
  const updateCloud = vi.fn(
    async (): Promise<unknown> => ({ completed: true }),
  );
  const dependencies = {
    getState: vi.fn(() => readyState),
    cancelPreview,
    markLocalComplete,
    updateCloud,
    isCurrent: vi.fn(() => true),
  };
  return dependencies;
};

describe('onboarding completion', () => {
  it('saves device readiness before updating the cloud', async () => {
    const dependencies = setup();
    await completeOnboarding('student-a', dependencies);
    expect(dependencies.cancelPreview).toHaveBeenCalledOnce();
    expect(dependencies.markLocalComplete).toHaveBeenCalledWith('student-a');
    expect(dependencies.updateCloud).toHaveBeenCalledOnce();
    expect(
      dependencies.markLocalComplete.mock.invocationCallOrder[0],
    ).toBeLessThan(dependencies.updateCloud.mock.invocationCallOrder[0]);
  });

  it('allows retrying after the cloud update fails', async () => {
    const dependencies = setup();
    dependencies.updateCloud
      .mockRejectedValueOnce(new Error('Account services are unavailable.'))
      .mockResolvedValueOnce({ completed: true });
    await expect(completeOnboarding('student-a', dependencies)).rejects.toThrow(
      'Account services are unavailable.',
    );
    expect(dependencies.markLocalComplete).toHaveBeenCalledOnce();
    await completeOnboarding('student-a', dependencies);
    expect(dependencies.markLocalComplete).toHaveBeenCalledTimes(2);
    expect(dependencies.updateCloud).toHaveBeenCalledTimes(2);
  });

  it('treats a lost session response as retryable without losing local readiness', async () => {
    const dependencies = setup();
    dependencies.updateCloud.mockResolvedValueOnce(null);
    await expect(completeOnboarding('student-a', dependencies)).rejects.toThrow(
      'Sign in again to finish onboarding.',
    );
    expect(dependencies.markLocalComplete).toHaveBeenCalledOnce();
  });

  it('does not mark local readiness without consent and a workspace', async () => {
    const dependencies = setup();
    dependencies.getState.mockReturnValueOnce({
      ...readyState,
      settings: { ...readyState.settings, consent: false },
    });
    await expect(completeOnboarding('student-a', dependencies)).rejects.toThrow(
      'Approve access and create your study browser first.',
    );
    expect(dependencies.markLocalComplete).not.toHaveBeenCalled();
    expect(dependencies.updateCloud).not.toHaveBeenCalled();
  });

  it('does not complete when the study browser is missing', async () => {
    const dependencies = setup();
    dependencies.getState.mockReturnValueOnce({
      ...readyState,
      workspace: { ...readyState.workspace!, ready: false },
    });
    await expect(completeOnboarding('student-a', dependencies)).rejects.toThrow(
      'Approve access and create your study browser first.',
    );
    expect(dependencies.markLocalComplete).not.toHaveBeenCalled();
    expect(dependencies.updateCloud).not.toHaveBeenCalled();
  });

  it('stops when the account changes during completion', async () => {
    const dependencies = setup();
    dependencies.isCurrent.mockReturnValue(false);
    await expect(completeOnboarding('student-a', dependencies)).rejects.toThrow(
      'Your session changed; sign in again.',
    );
    expect(dependencies.markLocalComplete).not.toHaveBeenCalled();
  });
});
