// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  activityRuntimeSdkDigest,
  activityRuntimeSdkSource,
  activityRuntimeSdkVersion,
} from '../lib/activity-runtime-sdk';
import type { ActivityRuntimeSdkApi } from '../lib/activity-runtime-sdk';

type ActivityWindow = Window &
  typeof globalThis & {
    ScholarActivity: ActivityRuntimeSdkApi;
  };

const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  document.body.replaceChildren();
  frames.splice(0).forEach((frame) => frame.remove());
});

const runSdk = () => {
  const messages: Record<string, unknown>[] = [];
  const frame = document.createElement('iframe');
  frame.src = 'about:blank';
  document.body.append(frame);
  frames.push(frame);
  const window = frame.contentWindow as unknown as ActivityWindow;
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'postMessage', {
    configurable: true,
    value: (message: string) => messages.push(JSON.parse(message)),
  });
  window.eval(activityRuntimeSdkSource);
  return { document: frame.contentDocument!, messages, window };
};

const sendHostMessage = (
  window: ActivityWindow,
  message: Record<string, unknown>,
) => {
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: JSON.stringify({ source: 'scholar-host', ...message }),
      origin: 'null',
      source: window,
    }),
  );
};

const runIdentity = {
  protocolVersion: 1,
  runtimeVersion: 'activity-runtime-v1',
  sessionId: 'session-1',
  artifactId: 'artifact-1',
  contentVersionId: 'version-1',
  attemptId: 'attempt-1',
  runId: 'run-1',
};

it('restores semantic state and reports only host-acknowledged revisions', () => {
  const { window, messages } = runSdk();
  const restored: unknown[] = [];
  window.ScholarActivity.onRestore((state: unknown) => restored.push(state));
  const state = {
    version: 1,
    inputs: { slope: 2 },
    rngSeed: 17,
    canvas: { range: [-2, 2] },
    progress: { explored: true },
  };
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest: 'digest-1',
    state,
    theme: {
      foreground: 'rgb(20, 30, 40)',
      primary: 'url(https://example.test/theme.svg)',
    },
  });

  expect(restored).toEqual([state]);
  expect(window.ScholarActivity.theme).toEqual({
    foreground: 'rgb(20, 30, 40)',
  });
  expect(messages[0]).toMatchObject({
    ...runIdentity,
    kind: 'ready',
    sequence: 1,
    baseStateRevision: 4,
    payload: { contentDigest: 'digest-1' },
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);

  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ ...state, inputs: { slope: 3 } })),
  );
  expect(messages[1]).toMatchObject({
    ...runIdentity,
    kind: 'state-proposed',
    sequence: 2,
    baseStateRevision: 4,
    payload: { state: { ...state, inputs: { slope: 3 } } },
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 2,
    stateRevision: 5,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);
});

it('coalesces state proposals while one checkpoint is awaiting acknowledgement', () => {
  const { window, messages } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest: 'digest-1',
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  });
  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ version: 1, inputs: { x: 1 } })),
  );
  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ version: 1, inputs: { x: 2 } })),
  );
  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ version: 1, inputs: { x: 3 } })),
  );
  expect(
    messages.filter((message) => message.kind === 'state-proposed'),
  ).toHaveLength(1);

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 2,
    stateRevision: 1,
  });
  expect(
    messages.filter((message) => message.kind === 'state-proposed'),
  ).toHaveLength(2);
  expect(messages[2]).toMatchObject({
    kind: 'state-proposed',
    baseStateRevision: 1,
    payload: { state: { version: 1, inputs: { x: 3 } } },
  });
});

it('notifies restore listeners registered after the host has restored state', () => {
  const { window } = runSdk();
  const state = { version: 1, inputs: { slope: 2 }, rngSeed: 17 };
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest: 'digest-1',
    state,
    theme: { foreground: 'rgb(20, 30, 40)' },
  });
  const restored: unknown[] = [];
  window.ScholarActivity.onRestore((value, stateRevision, theme) =>
    restored.push({ state: value, stateRevision, theme }),
  );

  expect(restored).toEqual([
    {
      state,
      stateRevision: 4,
      theme: { foreground: 'rgb(20, 30, 40)' },
    },
  ]);
});

it('can checkpoint null as a valid JSON state value', () => {
  const { messages, window } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest: 'digest-1',
    state: { version: 1, inputs: {}, rngSeed: 17 },
    theme: {},
  });
  window.ScholarActivity.proposeState(null);

  expect(messages.at(-1)).toMatchObject({
    ...runIdentity,
    kind: 'state-proposed',
    payload: { state: null },
  });
});

it('provides keyboard-accessible graph controls and textual Canvas2D alternatives', () => {
  const { document: activityDocument, window } = runSdk();
  const root = activityDocument.createElement('main');
  activityDocument.body.append(root);
  const changed: number[] = [];
  const range = window.ScholarActivity.controls.range({
    root,
    id: 'slope',
    label: 'Line slope',
    min: -5,
    max: 5,
    step: 1,
    value: 2,
    onInput: (value: number) => changed.push(value),
  });
  expect(range.input.type).toBe('range');
  expect(range.input.labels?.[0]?.textContent).toBe('Line slope');
  range.input.value = '3';
  range.input.dispatchEvent(new window.Event('input', { bubbles: true }));
  expect(changed).toEqual([3]);

  const svg = activityDocument.createElementNS(
    'http://www.w3.org/2000/svg',
    'svg',
  );
  window.ScholarActivity.graph.renderSvg({
    svg,
    points: [
      { x: 0, y: 2 },
      { x: 10, y: 12 },
    ],
    label: 'Line graph. Increasing by one for each step.',
  });
  expect(svg.getAttribute('role')).toBe('img');
  expect(svg.getAttribute('aria-label')).toContain('Increasing by one');
  expect(svg.querySelector('polyline')).not.toBeNull();

  const canvas = activityDocument.createElement('canvas');
  const drawCommands: unknown[][] = [];
  Object.defineProperty(canvas, 'getContext', {
    value: () =>
      Object.fromEntries(
        ['beginPath', 'moveTo', 'lineTo', 'stroke', 'clearRect'].map((name) => [
          name,
          (...args: unknown[]) => drawCommands.push([name, ...args]),
        ]),
      ),
  });
  window.ScholarActivity.graph.renderCanvas({
    canvas,
    points: [
      { x: 0, y: 2 },
      { x: 10, y: 12 },
    ],
    label: 'The simulated temperature rises from 2 to 12 degrees.',
  });
  expect(canvas.getAttribute('aria-label')).toContain('temperature rises');
  expect(drawCommands.some(([name]) => name === 'lineTo')).toBe(true);
});

it('reports local input feedback and sends reset only as an untrusted interaction request', () => {
  const { document: activityDocument, messages, window } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest: 'digest-1',
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  });
  const root = activityDocument.createElement('main');
  activityDocument.body.append(root);
  const input = window.ScholarActivity.controls.answerInput({
    root,
    id: 'answer',
    label: 'What is the slope?',
    expectedAnswer: '2',
    correctMessage: 'Correct: the slope is 2.',
    incorrectMessage: 'Try comparing the vertical and horizontal change.',
  });
  input.value.value = '2';
  input.form.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  expect(input.feedback.textContent).toBe('Correct: the slope is 2.');
  expect(input.feedback.getAttribute('role')).toBe('status');

  window.ScholarActivity.requestReset();
  expect(messages.at(-1)).toMatchObject({
    ...runIdentity,
    kind: 'interaction',
    payload: { action: 'request-reset', value: null },
  });
});

it('provides deterministic randomness from explicit seeds without network helpers', () => {
  const { window } = runSdk();
  const first = window.ScholarActivity.random(17, 0);
  expect(first).toBe(window.ScholarActivity.random(17, 0));
  expect(first).not.toBe(window.ScholarActivity.random(18, 0));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(1);
  expect(activityRuntimeSdkSource).not.toMatch(
    /(?:fetch|XMLHttpRequest|WebSocket|import\s*\()/,
  );
});

it('rejects malformed or oversized state and fingerprints the exact bundled bytes', () => {
  const { messages, window } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 7,
    contentDigest: 'digest-1',
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  });
  expect(() =>
    window.ScholarActivity.proposeState(
      window.JSON.parse('{"constructor":{"polluted":true}}'),
    ),
  ).toThrow();
  expect(() =>
    window.ScholarActivity.proposeState(
      window.JSON.parse(JSON.stringify({ text: 'x'.repeat(70 * 1024) })),
    ),
  ).toThrow();
  expect(
    messages.filter((message) => message.kind === 'state-proposed'),
  ).toHaveLength(0);

  expect(activityRuntimeSdkVersion).toBe('activity-runtime-v1');
  expect(activityRuntimeSdkDigest).toBe(
    createHash('sha256').update(activityRuntimeSdkSource, 'utf8').digest('hex'),
  );
});
