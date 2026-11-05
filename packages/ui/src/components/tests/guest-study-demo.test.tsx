// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GuestStudyDemo } from '../guest-study-demo';
let root: Root | undefined;
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((node) => node.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
it('offers a meaningful synthetic walkthrough without services or authentication', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  expect(container.textContent).toContain('Sample data');
  expect(container.textContent).toContain('No account needed');
  await click('Context');
  const note = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(note, 'I learn by trying examples.');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(note.value).toBe('I learn by trying examples.');
  await click('Study');
  expect(container.textContent).toContain('I learn by trying examples.');
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toContain('0\n1\n2');
  const slider = container.querySelector<HTMLElement>('input[type="range"]')!;
  expect(slider).not.toBeNull();
  expect(
    document.getElementById(slider.getAttribute('aria-labelledby')!)
      ?.textContent,
  ).toContain('Repetitions');
  await act(async () =>
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  );
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toBe('0\n1\n2\n3');
  await click('1, 2, 3');
  expect(container.textContent).toContain('Try again.');
  await click('0, 1, 2');
  expect(container.textContent).toContain('Exactly.');
  expect(container.textContent).toContain(
    'Your full AI workspace and connected courses require sign-in',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('honors explicit exit and sign-in actions', async () => {
  const onExit = vi.fn();
  const onSignIn = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(createElement(GuestStudyDemo, { onExit, onSignIn })),
  );
  await click('Exit demo');
  await click('Open the full experience');
  expect(onExit).toHaveBeenCalledOnce();
  expect(onSignIn).toHaveBeenCalledOnce();
});

it('calls only the fixed anonymous sample action and keeps live output separate', async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({
      text: '**A live explanation** of a loop.',
      model: 'muse-spark-1.3',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(GuestStudyDemo, { apiBaseURL: 'http://localhost:3000' }),
    ),
  );
  await click('Study');
  await click('Ask Meta to explain loops');
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/api/demo/tutor');
  const options = fetch.mock.calls[0]![1] as RequestInit;
  expect(options.credentials).toBe('omit');
  expect(options.body).toBe('{"action":"explain"}');
  expect(container.textContent).toContain('A live explanation of a loop.');
  expect(
    container.querySelector('[aria-label="Live AI response"] strong')
      ?.textContent,
  ).toBe('A live explanation');
  expect(container.textContent).toContain('Live response · muse-spark-1.3');
});

it('keeps the sample usable when the live demo is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: 'private server detail' }, { status: 503 }),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  await click('Study');
  await click('Ask Meta for a practice question');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'not enabled',
  );
  expect(container.textContent).not.toContain('private server detail');
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toBe('0\n1\n2');
});

it('always offers a full-experience sign-in banner with the host sign-in destination', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(GuestStudyDemo, { signInHref: '/sign-in?from=demo' }),
    ),
  );
  const banner = container.querySelector('[data-slot="alert"]');
  expect(banner?.textContent).toContain(
    'To access the full experience, sign in.',
  );
  expect(banner?.querySelector('a')?.getAttribute('href')).toBe(
    '/sign-in?from=demo',
  );
  await click('Study');
  expect(container.querySelector('[data-slot="alert"]')?.textContent).toContain(
    'To access the full experience, sign in.',
  );
});

it('ties pending samples to their question, clears stale responses, and lets the visitor cancel', async () => {
  let rejectPending: ((error: unknown) => void) | undefined;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        text: 'The first explanation.',
        model: 'muse-spark-1.3',
      }),
    )
    .mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
          options.signal?.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          );
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  await click('Study');
  await click('Ask Meta to explain loops');
  expect(container.textContent).toContain('The first explanation.');
  await click('Ask Meta for a practice question');
  expect(container.textContent).not.toContain('The first explanation.');
  expect(container.querySelector('[role="log"]')?.textContent).toContain(
    'Give me three beginner practice questions',
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'preparing',
  );
  await click('Cancel response');
  expect(container.textContent).toContain('Response canceled.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Ask Meta to explain loops',
    )?.disabled,
  ).toBe(false);
  expect(rejectPending).toBeDefined();
});

it('renders the live model scenario with prediction-gated local feedback and resets it when inputs change', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        text: 'Compare dissolved solute on each side of a membrane.',
        model: 'muse-spark-1.3',
        experiment: {
          kind: 'osmosis',
          title: 'A fictional cell',
          introduction: 'Compare dissolved solute on each side of a membrane.',
          insideConcentration: 8,
          outsideConcentration: 2,
          predictionQuestion: 'Where will water move?',
        },
      }),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  await click('Study');
  await click('Try a live osmosis experiment');
  const experiment = container.querySelector(
    '[aria-label="Live AI response"]',
  )!;
  expect(experiment.textContent).toContain('Live Meta scenario');
  expect(experiment.textContent).not.toContain('In this model, water');
  const reveal = [...experiment.querySelectorAll('button')].find(
    (button) => button.textContent === 'Reveal result',
  )!;
  expect(reveal.disabled).toBe(true);
  await click('Water leaves the cell');
  await click('Reveal result');
  expect(experiment.querySelector('[role="status"]')?.textContent).toContain(
    'water enters the cell',
  );
  expect(experiment.querySelector('[role="status"]')?.textContent).toContain(
    'Compare your prediction',
  );
  const sliders = experiment.querySelectorAll<HTMLElement>(
    'input[type="range"]',
  );
  await act(async () => {
    sliders[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    sliders[1]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
  });
  expect(experiment.querySelector('[role="status"]')).toBeNull();
  expect(reveal.disabled).toBe(true);
  await click('No net water movement');
  await click('Reveal result');
  expect(experiment.querySelector('[role="status"]')?.textContent).toContain(
    'concentrations are equal',
  );
  expect(experiment.querySelector('[role="status"]')?.textContent).toContain(
    'Your prediction matches',
  );
});

it('rejects malformed model experiment configuration without executing model content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        text: 'An invalid scenario',
        model: 'muse-spark-1.3',
        experiment: {
          kind: 'osmosis',
          title: 'Bad config',
          introduction: 'Synthetic scenario.',
          insideConcentration: 1000000,
          outsideConcentration: 2,
          predictionQuestion: 'Where will water move?',
          javascript: 'forbidden',
        },
      }),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(GuestStudyDemo)));
  await click('Study');
  await click('Try a live osmosis experiment');
  expect(container.querySelector('[aria-label="Live AI response"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'could not respond',
  );
  expect(
    container.querySelector('[data-testid="loop-output"]')?.textContent,
  ).toBe('0\n1\n2');
});
