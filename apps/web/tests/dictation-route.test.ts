import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  createDictation: vi.fn(),
  appendDictationAudio: vi.fn(),
  getDictationEvents: vi.fn(),
  stopDictation: vi.fn(),
  cancelDictation: vi.fn(),
  dictationControlActions: ['stop', 'cancel'] as const,
  DictationError: class DictationError extends Error {
    code = 'provider-failed' as const;
    status = 502;
  },
  serverEnv: {
    BETTER_AUTH_URL: 'https://scholaros.example',
  },
}));

vi.mock('@/lib/auth/helpers', () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock('@/data/env/server', () => ({ serverEnv: mocks.serverEnv }));
vi.mock('@scholaros/services/ai/dictation', () => ({
  createDictation: mocks.createDictation,
  appendDictationAudio: mocks.appendDictationAudio,
  getDictationEvents: mocks.getDictationEvents,
  stopDictation: mocks.stopDictation,
  cancelDictation: mocks.cancelDictation,
  dictationControlActions: mocks.dictationControlActions,
  DictationError: mocks.DictationError,
}));

import { POST as startDictation } from '../src/app/api/dictation/route';
import { GET as readDictationEvents } from '../src/app/api/dictation/events/route';
import { PUT as appendDictationAudio } from '../src/app/api/dictation/audio/route';
import {
  DELETE as deleteDictation,
  POST as controlDictation,
} from '../src/app/api/dictation/control/route';

const startPayload = {
  version: 1,
  requestId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session-test',
  composerRevision: 3,
};

const authenticatedRequest = (url: string, init: RequestInit) =>
  new Request(url, init);

const operationHeaders = {
  'X-Dictation-Session-Id': 'session-test',
  'X-Dictation-Composer-Revision': '3',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ userId: 'account-a' });
  mocks.createDictation.mockResolvedValue({
    operationId: 'operation-a',
  });
  mocks.appendDictationAudio.mockResolvedValue({ acceptedSequence: 0 });
  mocks.stopDictation.mockResolvedValue(undefined);
  mocks.cancelDictation.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('authenticated Meta dictation HTTP relay routes', () => {
  it('starts only a strict account-authenticated operation and accepts a missing Origin header', async () => {
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startPayload),
      },
    );

    const response = await startDictation(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationId: 'operation-a',
    });
    expect(mocks.createDictation).toHaveBeenCalledWith(
      'account-a',
      {
        requestId: startPayload.requestId,
        sessionId: startPayload.sessionId,
        composerRevision: startPayload.composerRevision,
      },
      expect.any(AbortSignal),
    );
  });

  it('cancels a ready operation if its start response connection was aborted', async () => {
    const controller = new AbortController();
    mocks.createDictation.mockImplementationOnce(async () => {
      controller.abort();
      return { operationId: 'operation-a' };
    });
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startPayload),
        signal: controller.signal,
      },
    );

    const response = await startDictation(request);

    expect(response.status).toBe(409);
    expect(mocks.cancelDictation).toHaveBeenCalledWith('account-a', {
      operationId: 'operation-a',
      sessionId: startPayload.sessionId,
      composerRevision: startPayload.composerRevision,
    });
  });

  it('rejects foreign origins, unsigned requests, and unknown start fields before upstream work', async () => {
    const request = (origin?: string) =>
      authenticatedRequest('https://scholaros.example/api/dictation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(startPayload),
      });

    expect((await startDictation(request('https://evil.example'))).status).toBe(
      403,
    );
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await startDictation(request())).status).toBe(401);
    expect(
      (
        await startDictation(
          authenticatedRequest('https://scholaros.example/api/dictation', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...startPayload, model: 'untrusted-model' }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.createDictation).not.toHaveBeenCalled();
  });

  it('forwards only bounded PCM bytes with host-checked operation and sequence headers', async () => {
    const forwardedBytes = new Uint8Array(4);
    mocks.appendDictationAudio.mockImplementationOnce(
      (_accountId: string, input: { bytes: Uint8Array; sequence: number }) => {
        forwardedBytes.set(input.bytes);
        return Promise.resolve({ acceptedSequence: input.sequence });
      },
    );
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation/audio?operationId=operation-a',
      {
        method: 'PUT',
        headers: {
          ...operationHeaders,
          'X-Dictation-Sequence': '0',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([0, 0, 1, 0]).buffer,
      },
    );

    const response = await appendDictationAudio(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acceptedSequence: 0 });
    expect(mocks.appendDictationAudio).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        operationId: 'operation-a',
        sessionId: 'session-test',
        composerRevision: 3,
        sequence: 0,
        bytes: expect.any(Uint8Array),
      }),
    );
    expect(forwardedBytes).toEqual(new Uint8Array([0, 0, 1, 0]));
    expect(mocks.appendDictationAudio.mock.calls[0][1].bytes).toEqual(
      new Uint8Array(4),
    );
  });

  it('bounds streamed frames even when Content-Length is absent', async () => {
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation/audio?operationId=operation-a',
      {
        method: 'PUT',
        headers: {
          ...operationHeaders,
          'X-Dictation-Sequence': '0',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(16_386).buffer,
      },
    );

    const response = await appendDictationAudio(request);

    expect(response.status).toBe(413);
    expect(mocks.appendDictationAudio).not.toHaveBeenCalled();
  });

  it('zeros buffered PCM when the request stream fails during ingress', async () => {
    const pcmChunk = new Uint8Array([1, 2, 3, 4]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pcmChunk);
        setTimeout(
          () => controller.error(new Error('private request body')),
          0,
        );
      },
    });
    const request = {
      url: 'https://scholaros.example/api/dictation/audio?operationId=operation-a',
      headers: new Headers({
        ...operationHeaders,
        'X-Dictation-Sequence': '0',
        'content-type': 'application/octet-stream',
      }),
      signal: new AbortController().signal,
      body,
    } as Request;

    const response = await appendDictationAudio(request);

    expect(response.status).toBe(502);
    expect(pcmChunk).toEqual(new Uint8Array(4));
    expect(mocks.appendDictationAudio).not.toHaveBeenCalled();
  });

  it('streams typed no-store SSE events and binds the reader to the operation revision', async () => {
    const events = [
      {
        version: 1 as const,
        operationId: 'operation-a',
        sessionId: 'session-test',
        composerRevision: 3,
        sequence: 1,
        kind: 'ready' as const,
      },
      {
        version: 1 as const,
        operationId: 'operation-a',
        sessionId: 'session-test',
        composerRevision: 3,
        sequence: 2,
        kind: 'partial' as const,
        text: 'hello',
      },
      {
        version: 1 as const,
        operationId: 'operation-a',
        sessionId: 'session-test',
        composerRevision: 3,
        sequence: 3,
        kind: 'ended' as const,
      },
    ];
    mocks.getDictationEvents.mockReturnValue(
      (async function* () {
        yield* events;
      })(),
    );
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation/events?operationId=operation-a',
      { headers: operationHeaders },
    );

    const response = await readDictationEvents(request);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(text.match(/data:/g)).toHaveLength(3);
    expect(mocks.getDictationEvents).toHaveBeenCalledWith('account-a', {
      operationId: 'operation-a',
      sessionId: 'session-test',
      composerRevision: 3,
    });
  });

  it('stops and cancels through separate authenticated controls', async () => {
    const stopResponse = await controlDictation(
      authenticatedRequest('https://scholaros.example/api/dictation/control', {
        method: 'POST',
        headers: {
          ...operationHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: 'operation-a', action: 'stop' }),
      }),
    );
    const cancelResponse = await deleteDictation(
      authenticatedRequest(
        'https://scholaros.example/api/dictation/control?operationId=operation-a',
        { method: 'DELETE', headers: operationHeaders },
      ),
    );

    expect(stopResponse?.status).toBe(200);
    expect(cancelResponse?.status).toBe(200);
    expect(mocks.stopDictation).toHaveBeenCalledWith('account-a', {
      operationId: 'operation-a',
      sessionId: 'session-test',
      composerRevision: 3,
    });
    expect(mocks.cancelDictation).toHaveBeenCalledWith('account-a', {
      operationId: 'operation-a',
      sessionId: 'session-test',
      composerRevision: 3,
    });
  });

  it('does not expose operation payloads, transcripts, or upstream errors in failure responses or logs', async () => {
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.createDictation.mockRejectedValue(
      new Error('private upstream transcript'),
    );
    const request = authenticatedRequest(
      'https://scholaros.example/api/dictation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startPayload),
      },
    );

    const response = await startDictation(request);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private upstream transcript');
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      'private upstream transcript',
    );
  });
});
