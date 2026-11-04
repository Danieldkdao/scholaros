import { describe, expect, it, vi } from 'vitest';
import type {
  DictationEvent,
  DictationStartInput,
} from '@scholaros/services/learning/speech-contracts';
import type { DictationClientError } from '../../../features/speech/services/dictation-client';
import type { DictationHostAdapterDependencies } from '../dictation-host-adapter';
import { createDictationHostAdapter } from '../dictation-host-adapter';
import type { DictationHostOwner } from '../dictation-host-adapter';

const startInput: DictationStartInput = {
  requestId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-test',
  composerRevision: 4,
};

const owner: DictationHostOwner = {
  accountId: 'account-a',
  senderId: 41,
};

const createEvent = (
  operationId: string,
  sequence: number,
  kind: 'ready' | 'partial' | 'final' | 'ended',
  text = '',
): DictationEvent => {
  const scope = {
    version: 1 as const,
    operationId,
    sessionId: startInput.sessionId,
    composerRevision: startInput.composerRevision,
    sequence,
  };
  switch (kind) {
    case 'ready':
      return { ...scope, kind };
    case 'partial':
    case 'final':
      return { ...scope, kind, text };
    case 'ended':
      return { ...scope, kind };
  }
};

type RelayOptions = {
  deferAudio?: boolean;
  deferDelete?: boolean;
  failEvents?: boolean;
};

type RelayCall = {
  path: string;
  method: string;
};

const createRelay = (options: RelayOptions = {}) => {
  const calls: RelayCall[] = [];
  const audioSequences: number[] = [];
  const audioResolvers: Array<(response: Response) => void> = [];
  let deleteResolver: ((response: Response) => void) | null = null;
  let eventController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let readySent = false;
  const queuedEvents: DictationEvent[] = [];
  const encoder = new TextEncoder();

  const sendEvent = (event: DictationEvent) => {
    if (!eventController) {
      queuedEvents.push(event);
      return;
    }
    try {
      eventController.enqueue(
        encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
      );
      if (event.kind === 'ended') {
        eventController.close();
        eventController = null;
      }
    } catch {
      eventController = null;
    }
  };

  const fetchAuthorized = vi.fn<
    DictationHostAdapterDependencies['authorizedFetch']
  >(async (path, init) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method });
    if (path === '/api/dictation')
      return Response.json({ operationId: 'operation-a' });
    if (path.startsWith('/api/dictation/audio?')) {
      const body = init.body;
      if (!(body instanceof ArrayBuffer))
        throw new Error('The host must send a bounded binary audio body.');
      const sequence = Number(
        new Headers(init.headers).get('X-Dictation-Sequence'),
      );
      audioSequences.push(sequence);
      const response = Response.json({ acceptedSequence: sequence });
      if (options.deferAudio)
        return new Promise<Response>((resolve) => audioResolvers.push(resolve));
      return response;
    }
    if (path.startsWith('/api/dictation/events?')) {
      if (options.failEvents)
        return Response.json(
          { error: 'Dictation services are offline.', code: 'offline' },
          { status: 503 },
        );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
          for (const event of queuedEvents.splice(0)) sendEvent(event);
          if (!readySent) {
            readySent = true;
            sendEvent(createEvent('operation-a', 1, 'ready'));
          }
        },
        cancel() {
          eventController = null;
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (path === '/api/dictation/control' && method === 'POST') {
      sendEvent(createEvent('operation-a', 3, 'final', 'recognized words'));
      sendEvent(createEvent('operation-a', 4, 'ended'));
      return Response.json({ operationId: 'operation-a' });
    }
    if (path.startsWith('/api/dictation/control?') && method === 'DELETE') {
      if (options.deferDelete)
        return new Promise<Response>((resolve) => {
          deleteResolver = resolve;
        });
      return Response.json({ operationId: 'operation-a' });
    }
    throw new Error(`Unexpected dictation route: ${method} ${path}`);
  });

  return {
    audioSequences,
    calls,
    fetchAuthorized,
    pushEvent: sendEvent,
    resolveAudio: () => {
      for (const resolve of audioResolvers.splice(0))
        resolve(Response.json({ acceptedSequence: 0 }));
    },
    resolveDelete: () => {
      deleteResolver?.(Response.json({ operationId: 'operation-a' }));
      deleteResolver = null;
    },
  };
};

type HarnessOptions = RelayOptions & {
  isCurrent?: DictationHostAdapterDependencies['isCurrent'];
};

const createHarness = (options: HarnessOptions = {}) => {
  const relay = createRelay(options);
  const published: Array<{ senderId: number; event: DictationEvent }> = [];
  const isCurrent = vi.fn<DictationHostAdapterDependencies['isCurrent']>(
    options.isCurrent ?? (async () => true),
  );
  const publishEvent = vi.fn<DictationHostAdapterDependencies['publishEvent']>(
    (senderId, event) => published.push({ senderId, event }),
  );
  const adapter = createDictationHostAdapter({
    authorizedFetch: relay.fetchAuthorized,
    isCurrent,
    publishEvent,
  });
  return { adapter, isCurrent, publishEvent, published, relay };
};

const operationIdFrom = (result: { operationId: string }) => result.operationId;

const expectCode = async (
  promise: Promise<unknown>,
  code: DictationClientError['code'],
) => expect(promise).rejects.toMatchObject({ code });

describe('dictation host adapter', () => {
  it('relays scoped editable events after the renderer can subscribe and waits for final drain', async () => {
    const { adapter, isCurrent, published, relay } = createHarness();
    const started = await adapter.startDictation(startInput, owner);
    const operationId = operationIdFrom(started);

    expect(relay.calls).toEqual([{ path: '/api/dictation', method: 'POST' }]);
    expect(published).toEqual([]);

    const audio = new Uint8Array([1, 2, 3, 4]);
    await adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: audio },
      owner,
    );
    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual(['ready']),
    );
    expect(audio).toEqual(new Uint8Array(4));

    relay.pushEvent(createEvent(operationId, 2, 'partial', 'recognized'));
    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual([
        'ready',
        'partial',
      ]),
    );

    await adapter.stopDictation({ operationId }, owner);

    expect(published.map(({ event }) => event.kind)).toEqual([
      'ready',
      'partial',
      'final',
      'ended',
    ]);
    expect(published.every(({ senderId }) => senderId === owner.senderId)).toBe(
      true,
    );
    expect(
      isCurrent.mock.calls.some(
        ([scope]) =>
          scope.operationId === operationId &&
          scope.accountId === owner.accountId &&
          scope.sessionId === startInput.sessionId &&
          scope.composerRevision === startInput.composerRevision,
      ),
    ).toBe(true);
    expect(
      relay.calls.some(
        ({ path, method }) =>
          path === '/api/dictation/control' && method === 'POST',
      ),
    ).toBe(true);
  });

  it('rejects another owner and drops transcript events after the session becomes stale', async () => {
    let current = true;
    const { adapter, published, relay } = createHarness({
      isCurrent: async (scope) =>
        current &&
        scope.accountId === owner.accountId &&
        scope.sessionId === startInput.sessionId,
    });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const wrongOwnerAudio = new Uint8Array([5, 6]);
    await expectCode(
      adapter.appendDictationAudio(
        { operationId, sequence: 0, bytes: wrongOwnerAudio },
        { accountId: 'account-b', senderId: owner.senderId + 1 },
      ),
      'not-found',
    );
    expect(wrongOwnerAudio).toEqual(new Uint8Array(2));
    expect(relay.calls.map(({ path }) => path)).toEqual(['/api/dictation']);

    await adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: new Uint8Array([7, 8]) },
      owner,
    );
    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual(['ready']),
    );
    current = false;
    relay.pushEvent(createEvent(operationId, 2, 'partial', 'stale words'));
    await vi.waitFor(() =>
      expect(
        relay.calls.some(
          ({ path, method }) =>
            path.startsWith('/api/dictation/control?') && method === 'DELETE',
        ),
      ).toBe(true),
    );

    expect(published.map(({ event }) => event.kind)).toEqual(['ready']);
    await adapter.cancelForOwner(owner);
  });

  it('bounds concurrent PCM buffering and zeroes every rejected buffer', async () => {
    const { adapter, relay } = createHarness({ deferAudio: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const oversizedAudio = new Uint8Array(16_386).fill(9);
    await expectCode(
      adapter.appendDictationAudio(
        { operationId, sequence: 0, bytes: oversizedAudio },
        owner,
      ),
      'limit-exceeded',
    );
    expect(oversizedAudio).toEqual(new Uint8Array(16_386));
    expect(relay.audioSequences).toEqual([]);

    const firstAudio = new Uint8Array(16_384).fill(1);
    const secondAudio = new Uint8Array(16_384).fill(1);
    const overflowAudio = new Uint8Array(16_384).fill(1);
    const first = adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: firstAudio },
      owner,
    );
    await vi.waitFor(() => expect(relay.audioSequences).toEqual([0]));
    const second = adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: secondAudio },
      owner,
    );
    const overflow = adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: overflowAudio },
      owner,
    );

    await expectCode(overflow, 'busy');
    expect(overflowAudio).toEqual(new Uint8Array(16_384));
    relay.resolveAudio();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { acceptedSequence: 0 },
      { acceptedSequence: 0 },
    ]);
    expect(firstAudio).toEqual(new Uint8Array(16_384));
    expect(secondAudio).toEqual(new Uint8Array(16_384));
    await adapter.cancelDictation({ operationId }, owner);
  });

  it('drains pending audio before stop and rejects frames after stop begins', async () => {
    const { adapter, relay } = createHarness({ deferAudio: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const audio = new Uint8Array([1, 2]);
    const appending = adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: audio },
      owner,
    );
    await vi.waitFor(() => expect(relay.audioSequences).toEqual([0]));
    const stopping = adapter.stopDictation({ operationId }, owner);

    expect(
      relay.calls.filter(
        ({ path, method }) =>
          path === '/api/dictation/control' && method === 'POST',
      ),
    ).toHaveLength(0);
    const lateAudio = new Uint8Array([3, 4]);
    await expectCode(
      adapter.appendDictationAudio(
        { operationId, sequence: 1, bytes: lateAudio },
        owner,
      ),
      'busy',
    );
    expect(lateAudio).toEqual(new Uint8Array(2));

    relay.resolveAudio();
    await expect(appending).resolves.toEqual({ acceptedSequence: 0 });
    await stopping;
    expect(audio).toEqual(new Uint8Array(2));
    expect(
      relay.calls.filter(
        ({ path, method }) =>
          path === '/api/dictation/control' && method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('awaits pending audio delivery and zeroes its buffer before disposal resolves', async () => {
    const { adapter, relay } = createHarness({
      deferAudio: true,
      deferDelete: true,
    });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const audio = new Uint8Array([1, 2]);
    const appending = adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: audio },
      owner,
    );
    await vi.waitFor(() => expect(relay.audioSequences).toEqual([0]));

    let disposed = false;
    const disposing = adapter.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() =>
      expect(
        relay.calls.filter(({ method }) => method === 'DELETE'),
      ).toHaveLength(1),
    );
    relay.resolveDelete();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);

    relay.resolveAudio();
    await expectCode(appending, 'cancelled');
    await disposing;
    expect(disposed).toBe(true);
    expect(audio).toEqual(new Uint8Array(2));
  });

  it('enforces the 120-second PCM ceiling before relaying excess audio', async () => {
    const { adapter, relay } = createHarness();
    const { operationId } = await adapter.startDictation(startInput, owner);

    for (let sequence = 0; sequence < 351; sequence += 1)
      await adapter.appendDictationAudio(
        {
          operationId,
          sequence,
          bytes: new Uint8Array(16_384),
        },
        owner,
      );

    const overflowAudio = new Uint8Array(16_384);
    await expectCode(
      adapter.appendDictationAudio(
        { operationId, sequence: 351, bytes: overflowAudio },
        owner,
      ),
      'limit-exceeded',
    );
    expect(overflowAudio).toEqual(new Uint8Array(16_384));
    expect(relay.audioSequences).toHaveLength(351);
    await adapter.cancelDictation({ operationId }, owner);
  });

  it('awaits matching session and owner cancellation without canceling another account', async () => {
    const { adapter, relay } = createHarness({ deferDelete: true });
    await adapter.startDictation(startInput, owner);
    await adapter.cancelForOwner({
      accountId: 'account-b',
      senderId: owner.senderId,
    });
    await adapter.cancelForSession({
      accountId: 'account-b',
      sessionId: startInput.sessionId,
    });
    expect(relay.calls.filter(({ method }) => method === 'DELETE')).toEqual([]);

    let sessionCancelled = false;
    const cancellingSession = adapter
      .cancelForSession({
        accountId: owner.accountId,
        sessionId: startInput.sessionId,
      })
      .then(() => {
        sessionCancelled = true;
      });
    await vi.waitFor(() =>
      expect(
        relay.calls.filter(({ method }) => method === 'DELETE'),
      ).toHaveLength(1),
    );
    expect(sessionCancelled).toBe(false);
    relay.resolveDelete();
    await cancellingSession;
    expect(sessionCancelled).toBe(true);

    await adapter.startDictation(startInput, owner);
    expect(
      relay.calls.filter(({ path }) => path === '/api/dictation'),
    ).toHaveLength(2);
    const cancellingOwner = adapter.cancelForOwner(owner);
    await vi.waitFor(() =>
      expect(
        relay.calls.filter(({ method }) => method === 'DELETE'),
      ).toHaveLength(2),
    );
    relay.resolveDelete();
    await cancellingOwner;
  });

  it('does not overlap a new start with an in-flight remote cancellation', async () => {
    const { adapter, relay } = createHarness({ deferDelete: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const cancellation = adapter.cancelDictation({ operationId }, owner);
    await vi.waitFor(() =>
      expect(
        relay.calls.filter(({ method }) => method === 'DELETE'),
      ).toHaveLength(1),
    );

    await expectCode(
      adapter.startDictation(
        { ...startInput, requestId: '00000000-0000-4000-8000-000000000002' },
        owner,
      ),
      'busy',
    );
    relay.resolveDelete();
    await cancellation;
    await expect(
      adapter.startDictation(
        { ...startInput, requestId: '00000000-0000-4000-8000-000000000002' },
        owner,
      ),
    ).resolves.toEqual({ operationId: 'operation-a' });
  });

  it('awaits an already-running owner-scoped operation cancellation', async () => {
    const { adapter, relay } = createHarness({ deferDelete: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    const firstCancellation = adapter.cancelDictation({ operationId }, owner);
    await vi.waitFor(() =>
      expect(
        relay.calls.filter(({ method }) => method === 'DELETE'),
      ).toHaveLength(1),
    );

    let secondSettled = false;
    const secondCancellation = adapter
      .cancelDictation({ operationId }, owner)
      .then(() => {
        secondSettled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);
    relay.resolveDelete();
    await Promise.all([firstCancellation, secondCancellation]);
    expect(secondSettled).toBe(true);
    expect(
      relay.calls.filter(({ method }) => method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('awaits an in-flight stale-session cancellation during disposal', async () => {
    let current = true;
    const { adapter, published, relay } = createHarness({
      deferDelete: true,
      isCurrent: async () => current,
    });
    const { operationId } = await adapter.startDictation(startInput, owner);
    await adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: new Uint8Array([1, 2]) },
      owner,
    );
    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual(['ready']),
    );
    current = false;
    relay.pushEvent(createEvent(operationId, 2, 'partial', 'stale words'));
    await vi.waitFor(() =>
      expect(
        relay.calls.some(
          ({ path, method }) =>
            path.startsWith('/api/dictation/control?') && method === 'DELETE',
        ),
      ).toBe(true),
    );

    let disposed = false;
    const disposing = adapter.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      relay.calls.filter(({ method }) => method === 'DELETE'),
    ).toHaveLength(1);
    expect(disposed).toBe(false);
    relay.resolveDelete();
    await disposing;
    expect(disposed).toBe(true);
    expect(published.map(({ event }) => event.kind)).toEqual(['ready']);
  });

  it('relays safe disconnect errors only while the original session is current', async () => {
    const { adapter, published, relay } = createHarness({ failEvents: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    await adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: new Uint8Array([1, 2]) },
      owner,
    );

    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual([
        'error',
        'ended',
      ]),
    );
    expect(published[0]).toMatchObject({
      senderId: owner.senderId,
      event: {
        operationId,
        sessionId: startInput.sessionId,
        composerRevision: startInput.composerRevision,
        kind: 'error',
        errorCode: 'offline',
      },
    });
    expect(
      relay.calls.some(
        ({ path, method }) =>
          path.startsWith('/api/dictation/control?') && method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('awaits remote cancellation during disposal and suppresses later events', async () => {
    const { adapter, published, relay } = createHarness({ deferDelete: true });
    const { operationId } = await adapter.startDictation(startInput, owner);
    await adapter.appendDictationAudio(
      { operationId, sequence: 0, bytes: new Uint8Array([1, 2]) },
      owner,
    );
    await vi.waitFor(() =>
      expect(published.map(({ event }) => event.kind)).toEqual(['ready']),
    );

    let disposed = false;
    const dispose = adapter.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() =>
      expect(
        relay.calls.some(
          ({ path, method }) =>
            path.startsWith('/api/dictation/control?') && method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(disposed).toBe(false);
    relay.pushEvent(createEvent(operationId, 2, 'partial', 'late transcript'));
    relay.resolveDelete();
    await dispose;

    expect(disposed).toBe(true);
    expect(published.map(({ event }) => event.kind)).toEqual(['ready']);
    await expectCode(adapter.startDictation(startInput, owner), 'cancelled');
  });
});
