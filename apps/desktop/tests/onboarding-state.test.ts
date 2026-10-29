// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingState } from '../src/features/onboarding/hooks/use-onboarding-state';
import type { OnboardingState } from '../src/features/onboarding/types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const stateFor = (accountId: string) =>
  ({
    accountId,
    settings: { notes: '' },
    discovery: {
      status: 'pending',
      message: null,
      discoveredAt: null,
      entries: [],
    },
    preferences: {
      launchAtLogin: { requested: false, applied: true, message: null },
      backgroundSync: { status: 'off', message: null, lastSyncedAt: null },
    },
  }) as unknown as OnboardingState;

type HookResult = ReturnType<typeof useOnboardingState>;

let latest: HookResult | null = null;

const Probe = () => {
  latest = useOnboardingState();
  return null;
};

const bridge = {
  getState: vi.fn(),
  onBackgroundSyncChange: vi.fn(() => () => undefined),
} as unknown as typeof window.scholar;

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  latest = null;
  vi.resetAllMocks();
  bridge.getState = vi.fn();
  bridge.onBackgroundSyncChange = vi.fn(() => () => undefined);
  window.scholar = bridge;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const render = async () => {
  await act(async () => {
    root?.render(createElement(Probe));
  });
};

describe('onboarding state loader', () => {
  it('applies the account state once it loads', async () => {
    bridge.getState.mockResolvedValue(stateFor('student-a'));
    await render();
    expect(latest?.state?.accountId).toBe('student-a');
  });

  it('drops a state response that lands after sign-out', async () => {
    let resolveState: (state: OnboardingState) => void = () => undefined;
    bridge.getState.mockReturnValue(
      new Promise<OnboardingState>((resolve) => {
        resolveState = resolve;
      }),
    );
    await render();
    const result = latest!;
    act(() => result.reset());
    await act(async () => {
      resolveState(stateFor('student-a'));
    });
    expect(latest?.state).toBeNull();
  });

  it('drops a saved-settings result that lands after sign-out', async () => {
    bridge.getState.mockResolvedValue(stateFor('student-a'));
    await render();
    const result = latest!;
    const saved = window.scholar.getState();
    act(() => result.reset());
    await act(async () => {
      result.setState(await saved);
    });
    expect(latest?.state).toBeNull();
  });

  it('ignores background sync events for another account', async () => {
    bridge.getState.mockResolvedValue(stateFor('student-a'));
    let emit: ((event: unknown) => void) | null = null;
    bridge.onBackgroundSyncChange.mockImplementation(
      (listener: (event: unknown) => void) => {
        emit = listener;
        return () => undefined;
      },
    );
    await render();
    act(() => {
      emit?.({
        accountId: 'student-b',
        state: { status: 'syncing', message: null, lastSyncedAt: null },
      });
    });
    expect(latest?.state?.accountId).toBe('student-a');
    act(() => {
      emit?.({
        accountId: 'student-a',
        state: { status: 'syncing', message: null, lastSyncedAt: null },
      });
    });
    expect(latest?.state?.preferences.backgroundSync.status).toBe('syncing');
    const result = latest!;
    act(() => result.reset());
    act(() => {
      emit?.({
        accountId: 'student-a',
        state: { status: 'waiting', message: null, lastSyncedAt: null },
      });
    });
    expect(latest?.state).toBeNull();
  });

  it('reloads account state after a reset', async () => {
    bridge.getState.mockResolvedValue(stateFor('student-a'));
    await render();
    const result = latest!;
    act(() => result.reset());
    bridge.getState.mockResolvedValue(stateFor('student-b'));
    await act(async () => {
      await result.reload();
    });
    expect(latest?.state?.accountId).toBe('student-b');
  });
});
