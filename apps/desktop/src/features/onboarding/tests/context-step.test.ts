import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ContextStep } from '../components/context-step';

it('only asks for optional additional information without discovery controls', () => {
  const markup = renderToStaticMarkup(
    createElement(ContextStep, {
      notes: 'I use a separate lab site.',
      busy: false,
      onNotesChange: () => undefined,
      onNotesBlur: () => undefined,
    }),
  );
  expect(markup).toContain('Anything else');
  expect(markup).toContain('I use a separate lab site.');
  expect(markup.match(/<textarea/g)).toHaveLength(1);
  expect(markup).not.toMatch(
    /Course map|Discover my courses|Refresh course map|primary-lms|<button/,
  );
});

it('offers background preferences without a manual onboarding scan', async () => {
  const { PreferencesStep } = await import('../components/preferences-step');
  const state = {
    settings: { launchAtLogin: false, backgroundSync: true, consent: true },
    workspace: { ready: true },
    connections: [{ status: 'confirmed' }],
    preferences: {
      launchAtLogin: { applied: true },
      backgroundSync: { status: 'waiting', message: null, lastSyncedAt: null },
    },
  };
  const markup = renderToStaticMarkup(
    createElement(PreferencesStep, {
      state: state as never,
      busy: false,
      onChange: () => undefined,
    }),
  );
  expect(markup).toContain('background-sync');
  expect(markup).not.toMatch(
    /Sync now|Pause background sync|Resume background sync|no model processing/,
  );
});
