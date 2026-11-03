import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDictationRegistry } from '../dictation-registry';
import {
  createDictationService,
  type DictationServiceDependencies,
} from '../dictation';

const startInput = {
  sessionId: 'session-test',
  requestId: '00000000-0000-4000-8000-000000000001',
  composerRevision: 3,
};

class SyntheticMetaSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sentFrames: Array<string | Buffer> = [];
  audioFrames: Buffer[] = [];
  terminated = false;
  holdAudioCallback = false;
  pendingAudioCallback: ((error?: Error) => void) | null = null;
  pendingAudioBuffer: Buffer | null = null;

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(
    data: string | Buffer,
    optionsOrCallback?: unknown,
    callback?: (error?: Error) => void,
  ) {
    const done =
      typeof optionsOrCallback === 'function'
        ? (optionsOrCallback as (error?: Error) => void)
        : callback;
    this.sentFrames.push(typeof data === 'string' ? data : Buffer.from(data));
    if (typeof data === 'string' && this.sentFrames.length === 1) {
      queueMicrotask(() => this.receive({ sessionId: 'synthetic-session' }));
    }
    if (typeof data === 'string' && data === '{"type":"endStream"}') {
      queueMicrotask(() => {
        this.receive({
          type: 'transcript',
          transcript: 'spoken request',
          final: true,
          audioProcessedMs: 250,
        });
        this.close(1000);
      });
    }
    if (Buffer.isBuffer(data)) this.audioFrames.push(Buffer.from(data));
    if (Buffer.isBuffer(data) && this.holdAudioCallback) {
      this.pendingAudioBuffer = data;
      this.pendingAudioCallback = done ?? null;
      return;
    }
    done?.();
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.alloc(0));
  }

  terminate() {
    this.terminated = true;
    this.pendingAudioCallback?.(new Error('synthetic socket closed'));
    this.pendingAudioCallback = null;
    this.close(1006);
  }

  receive(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  finishPendingAudioSend() {
    this.pendingAudioCallback?.();
    this.pendingAudioCallback = null;
  }
}

const createFixture = (
  now: () => number = Date.now,
  registry = createDictationRegistry(),
) => {
  const sockets: SyntheticMetaSocket[] = [];
  const urls: string[] = [];
  const dependencies: DictationServiceDependencies = {
    registry,
    getApiKey: () => 'fixture-only-secret',
    now,
    createWebSocket: (url) => {
      urls.push(url);
      const socket = new SyntheticMetaSocket();
      sockets.push(socket);
      return socket as never;
    },
  };

  return {
    service: createDictationService(dependencies),
    sockets,
    urls,
  };
};

afterEach(() => vi.useRealTimers());

describe('Meta realtime dictation protocol with a synthetic upstream fixture', () => {
  it('sends the server-authenticated handshake first and waits for its untyped acknowledgement', async () => {
    const { service, sockets, urls } = createFixture();

    const operation = await service.createDictation('account-a', startInput);
    const socket = sockets[0];
    const handshake = JSON.parse(String(socket.sentFrames[0]));

    expect(new URL(urls[0]).origin).toBe('wss://api.meta.ai');
    expect(new URL(urls[0]).pathname).toBe('/v1/asr/realtime');
    expect(new URL(urls[0]).searchParams.get('sessionId')).toBe(
      operation.operationId,
    );
    expect(urls[0]).not.toContain('fixture-only-secret');
    expect(handshake).toEqual({
      authorization: { accessToken: 'Bearer fixture-only-secret' },
      model: 'muse-voice-transcribe-1.0',
      audioEncoding: 'PCM_24KHZ',
      mode: 'PUSH_TO_TALK',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: true,
      languageBias: ['English'],
      keywords: [],
    });
    expect(socket.sentFrames).toHaveLength(1);
  });

  it('forwards sequenced PCM and accepts only one final after cumulative partials', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const socket = sockets[0];
    const audioBytes = new Uint8Array(12_000).fill(7);

    socket.receive({
      type: 'transcript',
      transcript: 'spoken re',
      final: false,
      audioProcessedMs: 100,
    });
    socket.receive({
      type: 'transcript',
      transcript: 'spoken request',
      final: false,
      audioProcessedMs: 200,
    });
    await service.appendDictationAudio('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
      sequence: 0,
      bytes: audioBytes,
    });
    await service.stopDictation('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    });

    const events = [];
    for await (const event of service.getDictationEvents('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    }))
      events.push(event);

    expect(socket.audioFrames).toEqual([Buffer.alloc(12_000, 7)]);
    expect(audioBytes).toEqual(new Uint8Array(12_000));
    expect(socket.sentFrames.at(-1)).toBe('{"type":"endStream"}');
    expect(events.map(({ kind }) => kind)).toEqual([
      'ready',
      'partial',
      'final',
      'ended',
    ]);
    expect(events.find(({ kind }) => kind === 'partial')).toMatchObject({
      text: 'spoken request',
    });
    expect(events.filter(({ kind }) => kind === 'final')).toHaveLength(1);
    expect(events.at(-1)?.sequence).toBeGreaterThan(
      events.at(-2)?.sequence ?? 0,
    );
  });

  it('rejects changed retries, sequence gaps, malformed PCM, and frames over 16 KiB', async () => {
    const { service } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const chunk = {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
      sequence: 0,
      bytes: new Uint8Array(4).fill(1),
    };

    await service.appendDictationAudio('account-a', chunk);
    await expect(
      service.appendDictationAudio('account-a', {
        ...chunk,
        bytes: new Uint8Array(4).fill(2),
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(
      service.appendDictationAudio('account-a', {
        ...chunk,
        sequence: 2,
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(
      service.appendDictationAudio('account-a', {
        ...chunk,
        sequence: 1,
        bytes: new Uint8Array(3),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      service.appendDictationAudio('account-a', {
        ...chunk,
        sequence: 1,
        bytes: new Uint8Array(16_386),
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('treats an identical sequence and digest retry as idempotent', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const chunk = {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
      sequence: 0,
      bytes: new Uint8Array(4).fill(3),
    };

    await service.appendDictationAudio('account-a', chunk);
    await service.appendDictationAudio('account-a', {
      ...chunk,
      bytes: new Uint8Array(4).fill(3),
    });

    expect(sockets[0].audioFrames).toHaveLength(1);
  });

  it('keeps accepted PCM at most one second ahead of realtime processing', async () => {
    const { service, sockets } = createFixture(() => 1_000);
    const operation = await service.createDictation('account-a', startInput);

    for (let sequence = 0; sequence < 3; sequence += 1)
      await service.appendDictationAudio('account-a', {
        operationId: operation.operationId,
        sessionId: startInput.sessionId,
        composerRevision: startInput.composerRevision,
        sequence,
        bytes: new Uint8Array(16_000),
      });

    await expect(
      service.appendDictationAudio('account-a', {
        operationId: operation.operationId,
        sessionId: startInput.sessionId,
        composerRevision: startInput.composerRevision,
        sequence: 3,
        bytes: new Uint8Array(16_000),
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(sockets[0].audioFrames).toHaveLength(3);
  });

  it('drains an already accepted PCM frame before sending endStream on Stop', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const socket = sockets[0];
    socket.holdAudioCallback = true;
    const appendResult = service.appendDictationAudio('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
      sequence: 0,
      bytes: new Uint8Array(12_000),
    });
    const appendSettled = appendResult.then(
      () => 'accepted',
      () => 'rejected',
    );
    const stopResult = service.stopDictation('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    });

    await Promise.resolve();
    expect(socket.audioFrames).toHaveLength(1);
    expect(socket.sentFrames.at(-1)).toBeInstanceOf(Buffer);
    socket.holdAudioCallback = false;
    socket.finishPendingAudioSend();
    await expect(appendSettled).resolves.toBe('accepted');
    await stopResult;
    expect(socket.sentFrames.at(-1)).toBe('{"type":"endStream"}');
  });

  it('maps Meta rate-limit close 1013 to a safe rate-limited event', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    sockets[0].close(1013);
    const events = [];

    for await (const event of service.getDictationEvents('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    }))
      events.push(event);

    expect(events.map(({ kind }) => kind)).toEqual(['ready', 'error', 'ended']);
    expect(events[1]).toMatchObject({
      kind: 'error',
      errorCode: 'rate-limited',
    });
  });

  it('invalidates before close and discards late final events on cancellation', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const socket = sockets[0];
    socket.receive({
      type: 'transcript',
      transcript: 'unfinished hypothesis',
      final: false,
      audioProcessedMs: 100,
    });
    const cancelPromise = service.cancelDictation('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    });
    socket.receive({
      type: 'transcript',
      transcript: 'late final',
      final: true,
      audioProcessedMs: 200,
    });
    await cancelPromise;

    const events = [];
    for await (const event of service.getDictationEvents('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    }))
      events.push(event);

    expect(socket.terminated).toBe(true);
    expect(events.some(({ kind }) => kind === 'final')).toBe(false);
    expect(events.at(-1)?.kind).toBe('ended');
  });

  it('keeps the accepted final when cancellation follows a completed Stop', async () => {
    const { service } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const operationScope = {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    };
    await service.stopDictation('account-a', operationScope);
    await service.cancelDictation('account-a', operationScope);

    const events = [];
    for await (const event of service.getDictationEvents(
      'account-a',
      operationScope,
    ))
      events.push(event);

    expect(events.map(({ kind }) => kind)).toEqual(['ready', 'final', 'ended']);
    expect(events.filter(({ kind }) => kind === 'final')).toHaveLength(1);
  });

  it('zeroes a pending PCM frame immediately when cancelled', async () => {
    const { service, sockets } = createFixture();
    const operation = await service.createDictation('account-a', startInput);
    const socket = sockets[0];
    socket.holdAudioCallback = true;
    const appendResult = service.appendDictationAudio('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
      sequence: 0,
      bytes: new Uint8Array(12_000).fill(9),
    });
    await Promise.resolve();
    expect(socket.pendingAudioBuffer?.some((byte) => byte !== 0)).toBe(true);

    await service.cancelDictation('account-a', {
      operationId: operation.operationId,
      sessionId: startInput.sessionId,
      composerRevision: startInput.composerRevision,
    });

    expect(socket.pendingAudioBuffer?.every((byte) => byte === 0)).toBe(true);
    await expect(appendResult).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('bounds per-account rate-limit state', async () => {
    const now = () => 1_000;
    const registry = createDictationRegistry();
    for (let index = 0; index < 1_024; index += 1)
      registry.rateLimits.set(`account-${index}-start`, {
        windowStartedAt: now(),
        count: 1,
      });
    const { service } = createFixture(now, registry);

    await expect(
      service.createDictation('account-new', startInput),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(registry.rateLimits.size).toBe(1_024);
  });

  it('enforces account ownership and a single live operation per account', async () => {
    const { service } = createFixture();
    const operation = await service.createDictation('account-a', startInput);

    await expect(
      service.createDictation('account-a', {
        ...startInput,
        requestId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    await expect(
      service.stopDictation('account-b', {
        operationId: operation.operationId,
        sessionId: startInput.sessionId,
        composerRevision: startInput.composerRevision,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
