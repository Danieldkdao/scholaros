import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundSyncControls } from '../background-sync-controls';
import type { OnboardingState } from '../../onboarding/types';

const stateFor = (
  status: OnboardingState['preferences']['backgroundSync']['status'],
) =>
  ({
    preferences: {
      backgroundSync: {
        status,
        message: status === 'blocked' ? 'Sign in again to resume.' : null,
        lastSyncedAt: null,
      },
    },
  }) as unknown as OnboardingState;

const render = (status: Parameters<typeof stateFor>[0]) =>
  renderToStaticMarkup(
    createElement(BackgroundSyncControls, {
      state: stateFor(status),
      busy: false,
      onPause: vi.fn(async () => undefined),
      onResume: vi.fn(async () => undefined),
    }),
  );

describe('dashboard background sync controls', () => {
  it.each(['waiting', 'syncing', 'blocked'] as const)(
    'offers a pause while sync is %s',
    (status) => {
      const markup = render(status);
      expect(markup).toContain('Pause background sync');
      expect(markup).not.toContain('Resume background sync');
    },
  );

  it('offers a resume while sync is paused', () => {
    const markup = render('paused');
    expect(markup).toContain('Resume background sync');
    expect(markup).not.toContain('Pause background sync');
  });

  it('shows no control when background sync is off', () => {
    expect(render('off')).toBe('');
  });
});
