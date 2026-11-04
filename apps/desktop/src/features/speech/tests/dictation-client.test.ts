import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDictationClient } from '../services/dictation-client';
import type { AuthorizedDictationFetch } from '../services/dictation-client';

const startInput = {
  requestId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-test',
  composerRevision: 4,
};

const event = (
  sequence: number,
  kind: 'ready' | 'partial' | 'final' | 'ended',
  text?: string,
) => ({
  version: 1 as const,
  operationId: 'operation-a',
  sessionId: 'session-test',
  composerRevision: 4,
  sequence,
  kind,
  ...(text === undefined ? {} : { text }),
});

const sseResponse = (events: unknown[]) => {
  const encoder = new TextEncoder();
  const body = events
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .join('');
  return new Response(encoder.encode(body), {
    headers: { 'content-type': 'text/event-stream' },
  });
};

afterEach(() => vi.restoreAllMocks());

describe('authenticated desktop Meta dictation client', () => {
  it('uses only the exact start route and validates the server operation response', async () => {
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(async () =>
      Response.json({ operationId: 'operation-a' }),
    );
    const client = createDictationClient(fetchAuthorized);

    const operation = await client.startDictation(startInput);

    expect(operation).toEqual({ operationId: 'operation-a' });
    expect(fetchAuthorized).toHaveBeenCalledWith(
      '/api/dictation',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(JSON.parse(String(fetchAuthorized.mock.calls[0][1].body))).toEqual({
      version: 1,
      ...startInput,
    });
    expect(JSON.stringify(fetchAuthorized.mock.calls)).not.toContain('Cookie');
  });

  it('sends PCM as bounded binary with sequence and captured session revision headers', async () => {
    const sentAudio = new Uint8Array(4);
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(
      async (path, init) => {
        if (path === '/api/dictation')
          return Response.json({ operationId: 'operation-a' });
        sentAudio.set(new Uint8Array(init.body as ArrayBuffer));
        return Response.json({ acceptedSequence: 0 });
      },
    );
    const client = createDictationClient(fetchAuthorized);
    const operation = await client.startDictation(startInput);
    const audio = new Uint8Array([1, 2, 3, 4]);

    await client.appendDictationAudio(operation.operationId, 0, audio);

    const [audioPath, init] = fetchAuthorized.mock.calls[1];
    expect(audioPath).toBe('/api/dictation/audio?operationId=operation-a');
    expect(init).toMatchObject({
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'X-Dictation-Sequence': '0',
        'X-Dictation-Session-Id': 'session-test',
        'X-Dictation-Composer-Revision': '4',
      },
    });
    expect(sentAudio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(audio).toEqual(new Uint8Array(4));
  });

  it('parses bounded cumulative SSE and accepts only one final event', async () => {
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(async (path) => {
      if (path === '/api/dictation')
        return Response.json({ operationId: 'operation-a' });
      if (path.startsWith('/api/dictation/events?'))
        return sseResponse([
          event(1, 'ready'),
          event(2, 'partial', 'hello'),
          event(3, 'partial', 'hello world'),
          event(4, 'final', 'hello world'),
          event(4, 'final', 'duplicate'),
          event(5, 'ended'),
        ]);
      return Response.json({ operationId: 'operation-a' });
    });
    const client = createDictationClient(fetchAuthorized);
    const operation = await client.startDictation(startInput);
    await client.stopDictation(operation.operationId);
    const received = [];

    for await (const item of client.getDictationEvents(operation.operationId))
      received.push(item);

    expect(received.map(({ kind }) => kind)).toEqual([
      'ready',
      'partial',
      'partial',
      'final',
      'ended',
    ]);
    expect(received.filter(({ kind }) => kind === 'final')).toHaveLength(1);
    expect(received.at(-1)?.sequence).toBe(5);
  });

  it('rejects event streams bound to another session or composer revision', async () => {
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(async (path) =>
      path === '/api/dictation'
        ? Response.json({ operationId: 'operation-a' })
        : sseResponse([
            {
              ...event(1, 'ready'),
              sessionId: 'other-session',
            },
            event(2, 'ended'),
          ]),
    );
    const client = createDictationClient(fetchAuthorized);
    const operation = await client.startDictation(startInput);

    await expect(
      (async () => {
        for await (const _item of client.getDictationEvents(
          operation.operationId,
        ))
          void _item;
      })(),
    ).rejects.toMatchObject({ code: 'session-changed' });
  });

  it('settles canceled starts promptly and cancels a late operation response', async () => {
    let resolveStart: (response: Response) => void = () => undefined;
    const pendingStartResponse = new Promise<Response>((resolve) => {
      resolveStart = resolve;
    });
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(async (path) =>
      path === '/api/dictation'
        ? pendingStartResponse
        : Response.json({ operationId: 'operation-a' }),
    );
    const client = createDictationClient(fetchAuthorized);
    const startOutcome = client.startDictation(startInput).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    await vi.waitFor(() => expect(fetchAuthorized).toHaveBeenCalledOnce());
    await client.cancelAll();
    const outcomeBeforeResponse = await Promise.race([
      startOutcome,
      new Promise<{ kind: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'pending' }), 0),
      ),
    ]);
    resolveStart(Response.json({ operationId: 'operation-a' }));
    await vi.waitFor(() => expect(fetchAuthorized).toHaveBeenCalledTimes(2));
    const outcomeAfterResponse = await startOutcome;

    expect(outcomeBeforeResponse).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
    expect(outcomeAfterResponse).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
    expect(fetchAuthorized.mock.calls.map(([path]) => path)).toEqual([
      '/api/dictation',
      '/api/dictation/control?operationId=operation-a',
    ]);
    expect(fetchAuthorized.mock.calls[1]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: {
        'X-Dictation-Session-Id': 'session-test',
        'X-Dictation-Composer-Revision': '4',
      },
    });
    expect(client.activeOperationCount()).toBe(0);
  });

  it('invalidates local events before awaiting remote cancellation', async () => {
    let eventSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    let resolveCancel!: (response: Response) => void;
    const cancelResponse = new Promise<Response>((resolve) => {
      resolveCancel = resolve;
    });
    const encoder = new TextEncoder();
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(
      async (path, init) => {
        if (path === '/api/dictation')
          return Response.json({ operationId: 'operation-a' });
        if (path.startsWith('/api/dictation/events?')) {
          eventSignal = init.signal ?? undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return cancelResponse;
      },
    );
    const client = createDictationClient(fetchAuthorized);
    const operation = await client.startDictation(startInput);
    const events = client.getDictationEvents(operation.operationId);
    const readyResult = events.next();
    await Promise.resolve();
    streamController!.enqueue(
      encoder.encode(`data: ${JSON.stringify(event(1, 'ready'))}\n\n`),
    );
    await expect(readyResult).resolves.toMatchObject({
      value: { kind: 'ready' },
    });
    const lateEventOutcome = events.next().then(
      (result) => ({ kind: 'event' as const, result }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    const cancelPromise = client.cancelAll();
    await Promise.resolve();
    const signalAbortedBeforeResponse = eventSignal?.aborted ?? false;
    const activeCountBeforeResponse = client.activeOperationCount();
    try {
      streamController!.enqueue(
        encoder.encode(
          `data: ${JSON.stringify(event(2, 'partial', 'late hypothesis'))}\n\n`,
        ),
      );
    } catch {
      // Cancellation may already have errored the synthetic stream.
    }
    const outcomeBeforeResponse = await Promise.race([
      lateEventOutcome,
      new Promise<{ kind: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'pending' }), 0),
      ),
    ]);
    resolveCancel(Response.json({ operationId: operation.operationId }));
    await cancelPromise;

    expect(signalAbortedBeforeResponse).toBe(true);
    expect(activeCountBeforeResponse).toBe(0);
    expect(outcomeBeforeResponse).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
  });

  it('uses authenticated cancellation to abort the owned SSE connection', async () => {
    let eventSignal: AbortSignal | undefined;
    const fetchAuthorized = vi.fn<AuthorizedDictationFetch>(
      async (path, init) => {
        if (path === '/api/dictation')
          return Response.json({ operationId: 'operation-a' });
        if (path.startsWith('/api/dictation/events?')) {
          eventSignal = init.signal ?? undefined;
          return new Response(
            new ReadableStream({
              start(controller) {
                eventSignal?.addEventListener(
                  'abort',
                  () => controller.error(new Error('stream aborted')),
                  { once: true },
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return Response.json({ operationId: 'operation-a' });
      },
    );
    const client = createDictationClient(fetchAuthorized);
    const operation = await client.startDictation(startInput);
    const pendingEvent = client
      .getDictationEvents(operation.operationId)
      .next();
    await Promise.resolve();

    await client.cancelAll();

    expect(fetchAuthorized.mock.calls.at(-1)?.[0]).toBe(
      '/api/dictation/control?operationId=operation-a',
    );
    expect(fetchAuthorized.mock.calls.at(-1)?.[1]).toMatchObject({
      method: 'DELETE',
      headers: {
        'X-Dictation-Session-Id': 'session-test',
        'X-Dictation-Composer-Revision': '4',
      },
    });
    expect(eventSignal?.aborted).toBe(true);
    await expect(pendingEvent).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.activeOperationCount()).toBe(0);
  });
});
