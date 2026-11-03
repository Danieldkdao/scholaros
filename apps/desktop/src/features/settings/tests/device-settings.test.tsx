// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { OnboardingState } from '../../onboarding/types';
import { DeviceSettings } from '../components/device-settings';
import type { DeviceReplacementActions } from '../components/device-settings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: Record<string, unknown>) =>
    createElement('a', { href: to, ...props }, children as string),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const browsers = [
  {
    id: 'chrome-install',
    browser: 'chrome' as const,
    name: 'Google Chrome',
    version: '1',
    icon: null,
  },
  {
    id: 'edge-install',
    browser: 'edge' as const,
    name: 'Microsoft Edge',
    version: '1',
    icon: null,
  },
];

const makeState = (browser: 'chrome' | 'edge' | null): OnboardingState =>
  ({
    accountId: 'student-a',
    settings: {
      step: 'review',
      consent: true,
      launchAtLogin: false,
      backgroundSync: false,
      decisionTimeSeconds: 1,
      blockedWords: [],
      notes: '',
      localSetupCompletedAt: new Date().toISOString(),
    },
    workspace: browser
      ? {
          browser,
          browserName:
            browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge',
          ready: true,
          status: 'ready',
          verifiedAt: new Date().toISOString(),
        }
      : null,
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
      launchAtLogin: { status: 'off', message: null },
      backgroundSync: { status: 'off', message: null, lastSyncedAt: null },
    },
  }) as unknown as OnboardingState;

const dto = {
  operationId: 'replacement-op',
  state: 'ready' as const,
  browserId: 'edge-install',
  errorCode: null,
  revision: 1,
};

const mount = async (
  actions: DeviceReplacementActions | null,
  onStateChange = vi.fn(),
  initialState = makeState('chrome'),
) => {
  const bridge = {
    findBrowsers: vi.fn(async () => browsers),
    createWorkspace: vi.fn(async () => makeState('edge')),
    getState: vi.fn(async () => makeState('edge')),
    saveSettings: vi.fn(async () => initialState),
  } as unknown as typeof window.scholar;
  window.scholar = bridge;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(DeviceSettings, {
        state: initialState,
        onStateChange,
        replacementActions: actions,
      }),
    ),
  );
  if (initialState.settings.consent)
    await vi.waitFor(() => expect(bridge.findBrowsers).toHaveBeenCalled());
  return { bridge, container, root };
};

const click = async (element: Element) =>
  act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

it('stages a replacement without changing the selected workspace and cancels safely', async () => {
  const actions: DeviceReplacementActions = {
    stage: vi.fn(async () => dto),
    commit: vi.fn(async () => ({ ...dto, state: 'needs-sign-in' as const })),
    cancel: vi.fn(async () => ({
      ...dto,
      state: 'cancelled' as const,
      revision: 2,
    })),
  };
  const onStateChange = vi.fn();
  const { bridge, container, root } = await mount(actions, onStateChange);

  await click(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Microsoft Edge'),
    )!,
  );

  expect(actions.stage).toHaveBeenCalledWith({
    requestId: expect.any(String),
    browserId: 'edge-install',
  });
  expect(bridge.createWorkspace).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Replace study browser'),
  );
  expect(onStateChange).not.toHaveBeenCalled();

  await click(
    document.body.querySelector('[data-slot="alert-dialog-cancel"]')!,
  );
  expect(actions.cancel).toHaveBeenCalledWith({
    operationId: 'replacement-op',
  });
  expect(actions.commit).not.toHaveBeenCalled();
  expect(onStateChange).not.toHaveBeenCalled();

  await act(async () => root.unmount());
});

it('commits only after explicit confirmation and reports school sign-in separately', async () => {
  const actions: DeviceReplacementActions = {
    stage: vi.fn(async () => dto),
    commit: vi.fn(async () => ({
      ...dto,
      state: 'needs-sign-in' as const,
      revision: 2,
    })),
    cancel: vi.fn(async () => ({
      ...dto,
      state: 'cancelled' as const,
      revision: 2,
    })),
  };
  const onStateChange = vi.fn();
  const { bridge, container, root } = await mount(actions, onStateChange);

  await click(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Microsoft Edge'),
    )!,
  );
  await vi.waitFor(() =>
    expect(
      document.body.querySelector('[data-slot="alert-dialog-action"]'),
    ).toBeTruthy(),
  );
  await click(
    document.body.querySelector('[data-slot="alert-dialog-action"]')!,
  );

  expect(actions.commit).toHaveBeenCalledWith({
    operationId: 'replacement-op',
    expectedRevision: 1,
  });
  expect(bridge.getState).toHaveBeenCalledOnce();
  expect(onStateChange).toHaveBeenCalledWith(
    expect.objectContaining({
      workspace: expect.objectContaining({ browser: 'edge' }),
    }),
  );
  expect(container.textContent).toContain('Sign in to your school again');

  await act(async () => root.unmount());
});

it('offers local consent and browser setup for an account without a device workspace', async () => {
  const initialState = makeState(null);
  const existingAccountWithoutDevice: OnboardingState = {
    ...initialState,
    settings: {
      ...initialState.settings,
      consent: false,
      localSetupCompletedAt: null,
    },
  };
  const { bridge, container, root } = await mount(
    null,
    vi.fn(),
    existingAccountWithoutDevice,
  );

  expect(container.textContent).toContain('This computer isn’t set up yet');
  const consent = container.querySelector('[role="checkbox"]')!;
  await click(consent);
  const continueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('Agree and continue'),
  )!;
  expect(continueButton.hasAttribute('disabled')).toBe(false);
  await click(continueButton);
  await vi.waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledOnce());
  expect(bridge.saveSettings).toHaveBeenCalledWith({ consent: true });

  await act(async () => root.unmount());
});

it('uses first-device setup only when there is no previously selected workspace', async () => {
  const { bridge, container, root } = await mount(
    null,
    vi.fn(),
    makeState(null),
  );

  await click(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Microsoft Edge'),
    )!,
  );

  expect(bridge.createWorkspace).toHaveBeenCalledWith('edge-install');
  await act(async () => root.unmount());
});

it('disables replacement choices until the safe device bridge is available', async () => {
  const { bridge, container, root } = await mount(null);
  const edgeButton = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Microsoft Edge'),
  )!;
  const locationButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('Choose browser location'),
  )!;

  expect(edgeButton.disabled).toBe(true);
  expect(locationButton.disabled).toBe(true);
  expect(container.textContent).toContain(
    'Safe browser replacement is unavailable right now;',
  );
  expect(bridge.createWorkspace).not.toHaveBeenCalled();

  await act(async () => root.unmount());
});
