import { describe, expect, it } from 'vitest';
import {
  adjacentOnboardingStep,
  canCompleteOnboarding,
  canStartOnboardingStep,
  needsDeviceSetup,
  resumeOnboardingStep,
} from '../lib/step-policy';
import type { OnboardingState, OnboardingStep } from '../types';

const baseState: OnboardingState = {
  accountId: 'student-a',
  settings: {
    step: 'welcome',
    consent: false,
    launchAtLogin: false,
    backgroundSync: false,
    notes: '',
    localSetupCompletedAt: null,
  },
  workspace: null,
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

const stateFor = (
  step: OnboardingStep,
  { consent = true, workspace = true, ready = true } = {},
): OnboardingState => ({
  ...baseState,
  settings: { ...baseState.settings, step, consent },
  workspace: workspace
    ? {
        browser: 'chrome',
        browserName: 'Google Chrome',
        ready,
        status: ready ? 'ready' : 'unverified',
        verifiedAt: ready ? '2026-01-01T00:00:00.000Z' : null,
      }
    : null,
});

describe('onboarding step policy', () => {
  it('always allows the welcome step', () => {
    expect(canStartOnboardingStep(baseState, 'welcome')).toBe(true);
  });

  it('requires consent before browser setup', () => {
    expect(canStartOnboardingStep(baseState, 'browser')).toBe(false);
    expect(
      canStartOnboardingStep(
        stateFor('browser', { workspace: false }),
        'browser',
      ),
    ).toBe(true);
  });

  it.each([
    'resources',
    'context',
    'preferences',
    'preview',
    'review',
  ] as const)('requires consent and a ready workspace before %s', (step) => {
    expect(canStartOnboardingStep(baseState, step)).toBe(false);
    expect(
      canStartOnboardingStep(stateFor(step, { workspace: false }), step),
    ).toBe(false);
    expect(canStartOnboardingStep(stateFor(step), step)).toBe(true);
  });

  it('does not treat a missing browser executable as a ready workspace', () => {
    const missingBrowser = stateFor('resources', { ready: false });
    expect(canStartOnboardingStep(missingBrowser, 'resources')).toBe(false);
    expect(canCompleteOnboarding(missingBrowser)).toBe(false);
    expect(needsDeviceSetup(missingBrowser)).toBe(true);
    expect(resumeOnboardingStep(missingBrowser)).toBe('browser');
  });

  it('resumes the saved step when its prerequisites are met', () => {
    expect(resumeOnboardingStep(stateFor('preferences'))).toBe('preferences');
  });

  it('resumes at welcome when consent was never granted', () => {
    expect(
      resumeOnboardingStep(stateFor('resources', { consent: false })),
    ).toBe('welcome');
  });

  it('resumes at browser when only consent was saved', () => {
    expect(
      resumeOnboardingStep(stateFor('preferences', { workspace: false })),
    ).toBe('browser');
  });

  it('walks to adjacent steps without escaping the flow', () => {
    expect(adjacentOnboardingStep('welcome', -1)).toBeNull();
    expect(adjacentOnboardingStep('welcome', 1)).toBe('browser');
    expect(adjacentOnboardingStep('review', 1)).toBeNull();
    expect(adjacentOnboardingStep('review', -1)).toBe('preview');
  });

  it('requires local consent and a ready workspace to finish', () => {
    expect(canCompleteOnboarding(baseState)).toBe(false);
    expect(
      canCompleteOnboarding(stateFor('review', { workspace: false })),
    ).toBe(false);
    expect(canCompleteOnboarding(stateFor('review'))).toBe(true);
  });

  it('treats a completed account without a local workspace as needing device setup', () => {
    expect(needsDeviceSetup(stateFor('review', { workspace: false }))).toBe(
      true,
    );
    expect(needsDeviceSetup(stateFor('review'))).toBe(false);
  });
});
