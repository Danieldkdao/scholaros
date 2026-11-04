// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  activityRuntimeSdkDigest,
  activityRuntimeSdkSource,
  activityRuntimeSdkVersion,
} from '../lib/activity-runtime-sdk';
import type { ActivityRuntimeSdkApi } from '../lib/activity-runtime-sdk';
import { buildActivityDocument } from '../services/activity-policy';

type ActivityWindow = Window &
  typeof globalThis & {
    ScholarActivity: ActivityRuntimeSdkApi;
  };

const frames: HTMLIFrameElement[] = [];
const parentPostMessageRestorers: Array<() => void> = [];
const activityHostOrigin = 'scholar-activity://fixture';

afterEach(() => {
  document.body.replaceChildren();
  frames.splice(0).forEach((frame) => frame.remove());
  parentPostMessageRestorers
    .splice(0)
    .reverse()
    .forEach((restore) => restore());
});

const runSdk = (parentOrigin = activityHostOrigin) => {
  const messages: Record<string, unknown>[] = [];
  const parentTargets: string[] = [];
  const frame = document.createElement('iframe');
  frame.src = 'about:blank';
  document.body.append(frame);
  frames.push(frame);
  const window = frame.contentWindow as unknown as ActivityWindow;
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, '__scholarActivityParentOrigin', {
    configurable: false,
    value: parentOrigin,
  });
  const parent = window.parent;
  const parentPostMessage = Object.getOwnPropertyDescriptor(
    parent,
    'postMessage',
  );
  Object.defineProperty(parent, 'postMessage', {
    configurable: true,
    value: (message: string, targetOrigin?: string) => {
      messages.push(JSON.parse(message));
      parentTargets.push(targetOrigin ?? '');
    },
  });
  parentPostMessageRestorers.push(() => {
    if (parentPostMessage)
      Object.defineProperty(parent, 'postMessage', parentPostMessage);
    else Reflect.deleteProperty(parent, 'postMessage');
  });
  window.eval(activityRuntimeSdkSource);
  return { document: frame.contentDocument!, messages, parentTargets, window };
};

const sendHostMessage = (
  window: ActivityWindow,
  message: Record<string, unknown>,
  origin = activityHostOrigin,
) => {
  const restoreDefaults = message.kind === 'restore' ? { readOnly: false } : {};
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: JSON.stringify({
        source: 'scholar-host',
        ...restoreDefaults,
        ...message,
      }),
      origin,
      source: window.parent,
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

const contentDigest = 'a'.repeat(64);

it('accepts host messages only from the wrapper parent at its bound origin', () => {
  const { messages, parentTargets, window } = runSdk();
  const restore = {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: { inputs: { slope: 2 }, progress: {} },
    theme: {},
    readOnly: false,
  };

  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: JSON.stringify({ source: 'scholar-host', ...restore }),
      origin: 'null',
      source: window,
    }),
  );
  expect(window.ScholarActivity.acknowledgedRevision).toBeNull();

  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: JSON.stringify({ source: 'scholar-host', ...restore }),
      origin: 'https://attacker.invalid',
      source: window.parent,
    }),
  );
  expect(window.ScholarActivity.acknowledgedRevision).toBeNull();

  sendHostMessage(window, restore);

  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  expect(messages).toHaveLength(1);
  expect(parentTargets).toEqual([activityHostOrigin]);
});

it('uses a wildcard target for an opaque sandboxed wrapper origin', () => {
  const { messages, parentTargets, window } = runSdk('null');
  const restore = {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest,
    state: {},
    theme: {},
    readOnly: false,
  };

  sendHostMessage(window, restore);
  expect(window.ScholarActivity.acknowledgedRevision).toBeNull();
  sendHostMessage(window, restore, 'null');

  expect(window.ScholarActivity.acknowledgedRevision).toBe(0);
  expect(messages[0]).toMatchObject({ kind: 'ready', sequence: 1 });
  expect(parentTargets).toEqual(['*']);
});

it('bridges the private bootstrap into the canonical P22 restore and ready protocol', () => {
  const restoredDigest = 'b'.repeat(64);
  const hostMessages: Record<string, unknown>[] = [];
  const bootstrapDocument = buildActivityDocument(
    {
      html: '<main></main>',
      css: '',
      sdk: '',
      javascript: '',
    },
    'test-nonce',
    'scholar-activity://fixture',
  );
  const bootstrapFrame = document.createElement('iframe');
  bootstrapFrame.src = 'about:blank';
  document.body.append(bootstrapFrame);
  frames.push(bootstrapFrame);
  const bootstrapWindow =
    bootstrapFrame.contentWindow! as unknown as ActivityWindow;
  bootstrapWindow.addEventListener('message', (event) => {
    if (
      event.source === bootstrapWindow.parent &&
      typeof event.data === 'string'
    )
      hostMessages.push(JSON.parse(event.data));
  });
  bootstrapWindow.eval(bootstrapDocument.bootstrapScript);
  const state = { inputs: { slope: 2 }, progress: { explored: true } };

  bootstrapWindow.dispatchEvent(
    new bootstrapWindow.MessageEvent('message', {
      data: JSON.stringify({
        source: 'scholar-host',
        kind: 'activity-bootstrap',
        protocolVersion: 1,
        runtimeVersion: 'activity-runtime-v1',
        nonce: 'test-nonce',
        sessionId: runIdentity.sessionId,
        artifactId: runIdentity.artifactId,
        contentVersionId: runIdentity.contentVersionId,
        attemptId: runIdentity.attemptId,
        runId: runIdentity.runId,
        contentDigest: restoredDigest,
        stateRevision: 4,
        initialState: state,
        theme: {},
        readOnly: false,
        css: '',
        sdk: '',
        javascript: '',
      }),
      origin: activityHostOrigin,
      source: bootstrapWindow.parent,
    }),
  );

  const restore = hostMessages.find((message) => message.kind === 'restore');
  expect(restore).toMatchObject({
    source: 'scholar-host',
    ...runIdentity,
    sequence: 1,
    kind: 'restore',
    stateRevision: 4,
    contentDigest: restoredDigest,
    state,
    theme: {},
    readOnly: false,
  });

  const { messages, window } = runSdk();
  const restored: unknown[] = [];
  window.ScholarActivity.onRestore((value) => restored.push(value));
  sendHostMessage(window, restore as Record<string, unknown>);

  expect(restored).toEqual([state]);
  expect(messages).toEqual([
    expect.objectContaining({
      ...runIdentity,
      source: 'activity',
      kind: 'ready',
      sequence: 1,
      baseStateRevision: 4,
      payload: { contentDigest: restoredDigest },
    }),
  ]);
});

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
    contentDigest,
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
    source: 'activity',
    kind: 'ready',
    sequence: 1,
    baseStateRevision: 4,
    payload: { contentDigest },
  });
  expect(messages[0].payload).toEqual({ contentDigest });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);

  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ ...state, inputs: { slope: 3 } })),
  );
  expect(messages[1]).toMatchObject({
    ...runIdentity,
    source: 'activity',
    kind: 'state-proposed',
    sequence: 2,
    baseStateRevision: 4,
    payload: { state: { ...state, inputs: { slope: 3 } } },
  });
  expect(messages[1].payload).toEqual({
    state: { ...state, inputs: { slope: 3 } },
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 2,
    acknowledgedSequence: 2,
    stateRevision: 5,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);
});

it('keeps saved activities locally interactive without sending writes in read-only mode', () => {
  const { window, messages } = runSdk();
  const initialState = {
    version: 1,
    inputs: { slope: 2 },
    rngSeed: 17,
    canvas: {},
    progress: { explored: false },
  };
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: initialState,
    theme: {},
    readOnly: true,
  });
  const interactiveState = {
    ...initialState,
    inputs: { slope: 5 },
    progress: { explored: true },
  };

  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify(interactiveState)),
  );
  window.ScholarActivity.interaction(
    'submit-answer',
    window.JSON.parse(JSON.stringify({ value: 5 })),
  );

  expect(window.ScholarActivity.readOnly).toBe(true);
  expect(window.ScholarActivity.getState()).toEqual(interactiveState);
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  expect(messages).toEqual([
    expect.objectContaining({
      ...runIdentity,
      source: 'activity',
      kind: 'ready',
      sequence: 1,
      baseStateRevision: 4,
      payload: { contentDigest },
    }),
  ]);
});

it('acknowledges interactions only through the sequenced host protocol', () => {
  const { window, messages } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: {},
    theme: {},
    readOnly: false,
  });
  const acknowledged = vi.fn();
  window.addEventListener(
    'scholar-activity:interaction-acknowledged',
    acknowledged,
  );

  window.ScholarActivity.interaction(
    'answer-selected',
    window.JSON.parse(JSON.stringify({ answer: 'b' })),
  );
  const interaction = messages.at(-1)!;
  const interactionMessage = interaction as {
    sequence: number;
    payload: { action: string; value: unknown };
  };
  expect(interactionMessage.payload).toEqual({
    action: 'answer-selected',
    value: { answer: 'b' },
  });

  sendHostMessage(window, {
    ...runIdentity,
    sequence: 2,
    kind: 'interaction-acknowledged',
    acknowledgedSequence: interactionMessage.sequence,
  });

  expect(acknowledged).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.objectContaining({
        sequence: interactionMessage.sequence,
      }),
    }),
  );
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
});

it('keeps a rejected checkpoint pending until the host retries the same saved proposal', () => {
  const { window, messages } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: { inputs: { frequency: 3 } },
    theme: {},
    readOnly: false,
  });
  const proposal = window.JSON.parse(
    JSON.stringify({ inputs: { frequency: 8 } }),
  );
  window.ScholarActivity.proposeState(proposal);
  const proposalMessage = messages.at(-1)! as { sequence: number };

  sendHostMessage(window, {
    ...runIdentity,
    sequence: 2,
    kind: 'state-rejected',
    acknowledgedSequence: proposalMessage.sequence,
    stateRevision: 4,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  expect(window.ScholarActivity.getState()).toEqual(proposal);

  sendHostMessage(window, {
    ...runIdentity,
    sequence: 3,
    kind: 'state-acknowledged',
    acknowledgedSequence: proposalMessage.sequence,
    stateRevision: 5,
  });

  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);
  expect(window.ScholarActivity.getState()).toEqual(proposal);
  expect(messages).toHaveLength(2);
});

it('requires a sequence-one restore and ignores later restore envelopes', () => {
  const { window, messages } = runSdk();
  const restore = {
    kind: 'restore',
    ...runIdentity,
    stateRevision: 0,
    contentDigest,
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  };

  sendHostMessage(window, { ...restore, sequence: 2 });
  expect(messages).toHaveLength(0);
  expect(window.ScholarActivity.acknowledgedRevision).toBeNull();

  sendHostMessage(window, {
    ...restore,
    sequence: 1,
    contentDigest: 'digest-1',
  });
  expect(messages).toHaveLength(0);

  sendHostMessage(window, { ...restore, sequence: 1 });
  expect(messages).toHaveLength(1);
  sendHostMessage(window, {
    ...restore,
    sequence: 2,
    sessionId: 'replacement-session',
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    ...runIdentity,
    kind: 'ready',
    sequence: 1,
    payload: { contentDigest },
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(0);
});

it('rejects stale host identity, sequence, version, source, and revision envelopes', () => {
  const { window } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  });
  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ version: 1, inputs: { slope: 3 } })),
  );

  const invalidEnvelopes = [
    { source: 'untrusted' },
    { protocolVersion: 2 },
    { runtimeVersion: 'activity-runtime-v2' },
    { sessionId: 'session-2' },
    { artifactId: 'artifact-2' },
    { contentVersionId: 'version-2' },
    { attemptId: 'attempt-2' },
    { runId: 'run-2' },
    { sequence: 3 },
    { stateRevision: 6 },
  ];
  for (const invalidEnvelope of invalidEnvelopes) {
    sendHostMessage(window, {
      kind: 'state-acknowledged',
      ...runIdentity,
      sequence: 2,
      stateRevision: 5,
      ...invalidEnvelope,
    });
    expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  }

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 2,
    acknowledgedSequence: 2,
    stateRevision: 5,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);

  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify({ version: 1, inputs: { slope: 4 } })),
  );
  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 2,
    acknowledgedSequence: 3,
    stateRevision: 6,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 3,
    acknowledgedSequence: 3,
    stateRevision: 6,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(6);
});

it('keeps a rejected checkpoint pending until the host retry is acknowledged', () => {
  const { messages, window } = runSdk();
  const initialState = {
    version: 1,
    inputs: { slope: 2 },
    rngSeed: 17,
    canvas: {},
    progress: {},
  };
  const proposedState = { ...initialState, inputs: { slope: 3 } };
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 4,
    contentDigest,
    state: initialState,
    theme: {},
  });
  const acknowledgements: Event[] = [];
  const rejections: Event[] = [];
  window.addEventListener('scholar-activity:state-acknowledged', (event) =>
    acknowledgements.push(event),
  );
  window.addEventListener('scholar-activity:state-rejected', (event) =>
    rejections.push(event),
  );

  window.ScholarActivity.proposeState(
    window.JSON.parse(JSON.stringify(proposedState)),
  );
  expect(messages.at(-1)).toMatchObject({
    kind: 'state-proposed',
    sequence: 2,
    baseStateRevision: 4,
    payload: { state: proposedState },
  });
  sendHostMessage(window, {
    kind: 'state-rejected',
    ...runIdentity,
    sequence: 2,
    acknowledgedSequence: 2,
    stateRevision: 5,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  expect(window.ScholarActivity.getState()).toEqual(proposedState);
  expect(rejections).toHaveLength(0);

  sendHostMessage(window, {
    kind: 'state-rejected',
    ...runIdentity,
    sequence: 2,
    acknowledgedSequence: 2,
    stateRevision: 4,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(4);
  expect(window.ScholarActivity.getState()).toEqual(proposedState);
  expect(rejections).toHaveLength(1);
  expect(acknowledgements).toHaveLength(0);
  expect('retryState' in window.ScholarActivity).toBe(false);

  sendHostMessage(window, {
    kind: 'state-acknowledged',
    ...runIdentity,
    sequence: 3,
    acknowledgedSequence: 2,
    stateRevision: 5,
  });
  expect(window.ScholarActivity.acknowledgedRevision).toBe(5);
  expect(window.ScholarActivity.getState()).toEqual(proposedState);
  expect(acknowledgements).toHaveLength(1);
  expect(
    messages.filter((message) => message.kind === 'state-proposed'),
  ).toHaveLength(1);
});

it('coalesces state proposals while one checkpoint is awaiting acknowledgement', () => {
  const { window, messages } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest,
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
    acknowledgedSequence: 2,
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
    contentDigest,
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
    contentDigest,
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
    contentDigest,
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

it('emits interactions with the canonical action and value payload', () => {
  const { messages, window } = runSdk();
  sendHostMessage(window, {
    kind: 'restore',
    ...runIdentity,
    sequence: 1,
    stateRevision: 0,
    contentDigest,
    state: { version: 1, inputs: {}, rngSeed: 17, canvas: {}, progress: {} },
    theme: {},
  });

  window.ScholarActivity.interaction(
    'answer-submitted',
    window.JSON.parse(JSON.stringify({ answer: 'x = 4' })),
  );

  expect(messages.at(-1)).toMatchObject({
    ...runIdentity,
    source: 'activity',
    kind: 'interaction',
    sequence: 2,
    baseStateRevision: 0,
    payload: { action: 'answer-submitted', value: { answer: 'x = 4' } },
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
    contentDigest,
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
