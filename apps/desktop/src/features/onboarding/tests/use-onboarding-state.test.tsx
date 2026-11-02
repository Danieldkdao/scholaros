// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useOnboardingState } from '../hooks/use-onboarding-state';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('subscribes before loading and applies only the current account watch status', async () => {
  const loaded = {
    accountId: 'student-a',
    settings: {},
    watch: { enabled: true, status: 'watching' },
  };
  let receiveWatchChange!: (change: {
    accountId: string;
    enabled: boolean;
    status: 'off' | 'watching' | 'checking';
  }) => void;
  const calls: string[] = [];
  window.scholar = {
    getState: vi.fn(async () => {
      calls.push('snapshot');
      return loaded;
    }),
    onBackgroundSyncChange: vi.fn(() => () => undefined),
    onWatchChange: vi.fn((listener) => {
      calls.push('subscribe');
      receiveWatchChange = listener;
      return () => undefined;
    }),
  } as unknown as typeof window.scholar;
  const container = document.createElement('div');
  const root = createRoot(container);
  const View = () => {
    const { state } = useOnboardingState();
    return createElement('output', null, JSON.stringify(state?.watch));
  };

  await act(async () => root.render(createElement(View)));
  expect(calls.slice(0, 2)).toEqual(['subscribe', 'snapshot']);
  expect(container.textContent).toContain('"status":"watching"');

  await act(async () =>
    receiveWatchChange({
      accountId: 'student-b',
      enabled: false,
      status: 'off',
    }),
  );
  expect(container.textContent).toContain('"status":"watching"');

  await act(async () =>
    receiveWatchChange({
      accountId: 'student-a',
      enabled: true,
      status: 'checking',
    }),
  );
  expect(container.textContent).toContain('"status":"checking"');
  await act(async () => root.unmount());
});
