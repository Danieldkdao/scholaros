import { describe, expect, it } from 'vitest';
import {
  activityMessageLimits,
  createActivityMailbox,
  type ActivityMailboxBinding,
} from '../services/activity-mailbox';
import {
  canForcefullyTerminateActivityRenderer,
  createActivityWebPreferences,
  isActivityResourceLimitExceeded,
} from '../services/activity-runtime';

const binding: ActivityMailboxBinding = {
  runtimeVersion: 'activity-runtime-v1',
  sessionId: 'session-1',
  artifactId: 'artifact-1',
  contentVersionId: 'version-1',
  attemptId: 'attempt-1',
  runId: 'run-1',
};

const stateMessage = (
  state: unknown,
  sequence = 1,
  baseStateRevision = 0,
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    protocolVersion: 1,
    source: 'activity',
    ...binding,
    sequence,
    baseStateRevision,
    kind: 'state-proposed',
    payload: { state },
    ...overrides,
  });

const interactionMessage = (sequence: number, data: unknown = null) =>
  JSON.stringify({
    protocolVersion: 1,
    source: 'activity',
    ...binding,
    sequence,
    baseStateRevision: 0,
    kind: 'interaction',
    payload: { action: 'input', value: data },
  });

const readyMessage = (sequence: number, contentDigest: string) =>
  JSON.stringify({
    protocolVersion: 1,
    source: 'activity',
    ...binding,
    sequence,
    baseStateRevision: 0,
    kind: 'ready',
    payload: { contentDigest },
  });

const stateMessageAtBytes = (sequence: number, targetBytes: number) => {
  const baseMessage = stateMessage({ text: '' }, sequence);
  const textBytes = targetBytes - Buffer.byteLength(baseMessage, 'utf8');
  const serializedMessage = stateMessage(
    { text: 'x'.repeat(textBytes) },
    sequence,
  );
  if (Buffer.byteLength(serializedMessage, 'utf8') !== targetBytes)
    throw new Error('Unable to make the requested state envelope size.');
  return serializedMessage;
};

const interactionMessageAtBytes = (sequence: number, targetBytes: number) => {
  const baseMessage = interactionMessage(sequence, { text: '' });
  const textBytes = targetBytes - Buffer.byteLength(baseMessage, 'utf8');
  const serializedMessage = interactionMessage(sequence, {
    text: 'x'.repeat(textBytes),
  });
  if (Buffer.byteLength(serializedMessage, 'utf8') !== targetBytes)
    throw new Error('Unable to make the requested event size.');
  return serializedMessage;
};

describe('activity mailbox', () => {
  it('accepts the canonical P22 ready envelope with the persisted artifact digest', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    expect(mailbox.enqueue(readyMessage(1, 'a'.repeat(64)))).toBe(true);
    expect(mailbox.readNext()).toBe(readyMessage(1, 'a'.repeat(64)));
  });

  it('accepts the canonical action/value interaction envelope', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });
    const message = interactionMessage(1, { input: 3 });

    expect(mailbox.enqueue(message)).toBe(true);
    expect(mailbox.readNext()).toBe(message);
  });

  it('rejects persistence and host interactions in a read-only runtime', () => {
    const readOnlyBinding = { ...binding, readOnly: true };
    const mailbox = createActivityMailbox({
      binding: readOnlyBinding,
      stateRevision: 0,
      now: () => 0,
    });
    expect(mailbox.enqueue(readyMessage(1, 'a'.repeat(64)))).toBe(true);
    expect(mailbox.readNext()).toBe(readyMessage(1, 'a'.repeat(64)));

    expect(
      mailbox.enqueue(
        JSON.stringify({
          protocolVersion: 1,
          source: 'activity',
          ...binding,
          sequence: 2,
          baseStateRevision: 0,
          kind: 'state-proposed',
          payload: { state: { input: 5 } },
        }),
      ),
    ).toBe(false);
    expect(mailbox.enqueue(interactionMessage(2, { input: 5 }))).toBe(false);
  });

  it('accepts a bounded full-state proposal larger than an ordinary event', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });
    const message = stateMessage({ text: 'x'.repeat(60 * 1024) });

    expect(Buffer.byteLength(message, 'utf8')).toBeGreaterThan(
      activityMessageLimits.ordinaryEventBytes,
    );
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
      activityMessageLimits.stateEnvelopeBytes,
    );
    expect(mailbox.enqueue(message)).toBe(true);
    expect(mailbox.readNext()).toBe(message);
  });

  it('rejects state larger than 64 KiB before it can be persisted', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    expect(mailbox.enqueue(stateMessage({ text: 'x'.repeat(66 * 1024) }))).toBe(
      false,
    );
    expect(mailbox.readNext()).toBeNull();
  });

  it('rejects spoofed bindings, unknown keys, stale sequences and stale revisions', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    expect(
      mailbox.enqueue(
        stateMessage({}, 1, 0, { artifactId: 'another-artifact' }),
      ),
    ).toBe(false);
    expect(
      mailbox.enqueue(
        JSON.stringify({
          ...JSON.parse(stateMessage({})),
          unexpected: 'tool-call',
        }),
      ),
    ).toBe(false);
    expect(mailbox.enqueue(stateMessage({}, 1, 1))).toBe(false);
    expect(mailbox.enqueue(stateMessage({}, 1, 0))).toBe(true);
    expect(mailbox.enqueue(stateMessage({}, 1, 0))).toBe(false);
  });

  it('accepts the exact 64 KiB full-state boundary and rejects the next byte', () => {
    const exactState = {
      text: 'x'.repeat(
        activityMessageLimits.stateBytes -
          Buffer.byteLength('{"text":""}', 'utf8'),
      ),
    };
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    expect(Buffer.byteLength(JSON.stringify(exactState), 'utf8')).toBe(
      activityMessageLimits.stateBytes,
    );
    expect(mailbox.enqueue(stateMessage(exactState))).toBe(true);
    expect(
      mailbox.enqueue(stateMessage({ text: `${exactState.text}x` }, 2)),
    ).toBe(false);
  });

  it('accepts an ordinary event of exactly 16 KiB and rejects one byte more', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    expect(
      mailbox.enqueue(
        interactionMessageAtBytes(1, activityMessageLimits.ordinaryEventBytes),
      ),
    ).toBe(true);
    expect(mailbox.readNext()).not.toBeNull();
    expect(
      mailbox.enqueue(
        interactionMessageAtBytes(
          2,
          activityMessageLimits.ordinaryEventBytes + 1,
        ),
      ),
    ).toBe(false);
  });

  it('accepts exactly eight queued messages and rejects a ninth', () => {
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => 0,
    });

    for (
      let sequence = 1;
      sequence <= activityMessageLimits.queueEntries;
      sequence += 1
    )
      expect(mailbox.enqueue(interactionMessage(sequence))).toBe(true);

    expect(mailbox.enqueue(interactionMessage(9))).toBe(false);
    expect(mailbox.queuedEntries).toBe(activityMessageLimits.queueEntries);
  });

  it('limits event bursts to 20 and refills at 10 events per second', () => {
    let now = 0;
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => now,
    });

    for (
      let sequence = 1;
      sequence <= activityMessageLimits.eventBurst;
      sequence += 1
    ) {
      expect(mailbox.enqueue(interactionMessage(sequence))).toBe(true);
      expect(mailbox.readNext()).not.toBeNull();
    }
    expect(
      mailbox.enqueue(interactionMessage(activityMessageLimits.eventBurst + 1)),
    ).toBe(false);

    now = 2_000;
    expect(
      mailbox.enqueue(interactionMessage(activityMessageLimits.eventBurst + 1)),
    ).toBe(true);
  });

  it('caps eight queued state envelopes at exactly 256 KiB total', () => {
    let now = 0;
    const mailbox = createActivityMailbox({
      binding,
      stateRevision: 0,
      now: () => now,
    });

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const message = stateMessageAtBytes(sequence, 64 * 1024);
      expect(mailbox.enqueue(message)).toBe(true);
      now += 500;
    }
    expect(mailbox.queuedEntries).toBe(4);
    expect(mailbox.queuedBytes).toBe(activityMessageLimits.queueBytes);
    expect(mailbox.enqueue(stateMessageAtBytes(5, 64 * 1024))).toBe(false);
  });
});

describe('activity web preferences', () => {
  it('uses a fresh explicit sandboxed session without preload or Node bridge', () => {
    const activitySession = { id: 'private-test-session' };
    const preferences = createActivityWebPreferences(activitySession as never);

    expect(preferences.session).toBe(activitySession);
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      webgl: false,
      enableWebSQL: false,
      disableDialogs: true,
      disableWakeLocks: true,
      navigateOnDragDrop: false,
      backgroundThrottling: true,
      devTools: false,
      spellcheck: false,
      v8CacheOptions: 'none',
    });
    expect(preferences).not.toHaveProperty('preload');
    expect(preferences).not.toHaveProperty('additionalArguments');
  });
});

describe('activity resource watchdog', () => {
  it('uses Electron working-set kilobytes and consecutive CPU samples', () => {
    const metric = {
      cpu: { percentCPUUsage: 0 },
      memory: { workingSetSize: 256 * 1024 },
    };

    expect(isActivityResourceLimitExceeded(metric, 0)).toBe(false);
    expect(
      isActivityResourceLimitExceeded(
        {
          ...metric,
          memory: { workingSetSize: metric.memory.workingSetSize + 1 },
        },
        0,
      ),
    ).toBe(true);
    expect(isActivityResourceLimitExceeded(metric, 5)).toBe(true);
  });
});

describe('activity renderer termination', () => {
  it('forcefully terminates only a known renderer outside trusted process IDs', () => {
    expect(canForcefullyTerminateActivityRenderer(0, [])).toBe(false);
    expect(canForcefullyTerminateActivityRenderer(17, [17, 23])).toBe(false);
    expect(canForcefullyTerminateActivityRenderer(17, [23])).toBe(true);
  });
});

it('seeds activity backgrounds and semantic tokens from the trusted host palette without accepting CSS injection', async () => {
  const { createActivityThemeCss, readActivityTheme } =
    await import('../services/activity-runtime');
  const executeJavaScript = async () => ({
    background: 'rgb(20, 21, 22)',
    foreground: 'rgb(240, 241, 242)',
    primary: 'oklch(0.7 0.1 120)',
    muted: 'rgb(30, 31, 32)',
    mutedForeground: 'rgb(170, 171, 172)',
    border: 'red; background:url(https://invalid.test)',
    colorScheme: 'dark',
  });
  const theme = await readActivityTheme({ executeJavaScript } as never);
  const css = createActivityThemeCss(theme);
  expect(css).toContain('--background:rgb(20, 21, 22)');
  expect(css).toContain('background:var(--background)!important');
  expect(css).toContain('color:var(--foreground)!important');
  expect(css).toContain('color-scheme:dark');
  expect(css).toContain('--muted-foreground:rgb(170, 171, 172)');
  expect(css).toContain('.muted{color:var(--muted-foreground)!important}');
  expect(createActivityThemeCss({})).not.toContain('.muted');
  expect(css).not.toContain('invalid.test');
  expect(theme.border).toBeUndefined();
});
