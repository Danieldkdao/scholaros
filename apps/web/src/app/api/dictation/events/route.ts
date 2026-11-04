import {
  DictationError,
  getDictationEvents,
} from '@scholaros/services/ai/dictation';
import type { DictationEvent } from '@scholaros/services/learning/speech-contracts';
import {
  idSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';

export const runtime = 'nodejs';
const noStoreHeaders = {
  'Cache-Control': 'no-store, no-transform',
  'Content-Type': 'text/event-stream; charset=utf-8',
  'X-Accel-Buffering': 'no',
};
const heartbeatIntervalMs = 15_000;

const getOperationId = (request: Request) => {
  const searchParams = new URL(request.url).searchParams;
  const operationIds = searchParams.getAll('operationId');
  if (
    operationIds.length !== 1 ||
    [...searchParams.keys()].length !== 1 ||
    !idSchema.safeParse(operationIds[0]).success
  )
    return null;
  return operationIds[0];
};

const getOperationHeaders = (request: Request) => {
  const sessionId = request.headers.get('x-dictation-session-id');
  const composerRevisionHeader = request.headers.get(
    'x-dictation-composer-revision',
  );
  if (!sessionId || !idSchema.safeParse(sessionId).success) return null;
  if (!composerRevisionHeader || !/^(0|[1-9]\d*)$/.test(composerRevisionHeader))
    return null;
  const parsedRevision = revisionSchema.safeParse(
    Number(composerRevisionHeader),
  );
  return parsedRevision.success
    ? { sessionId, composerRevision: parsedRevision.data }
    : null;
};

const errorResponse = (error: unknown) => {
  if (error instanceof DictationError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  console.error('[api/dictation] request failed', {
    kind: 'events',
    name: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json(
    { error: 'Meta dictation could not finish.', code: 'provider-failed' },
    { status: 502, headers: { 'Cache-Control': 'no-store' } },
  );
};

const createEventStream = (events: AsyncIterableIterator<DictationEvent>) => {
  const encoder = new TextEncoder();
  let nextEvent: Promise<IteratorResult<DictationEvent>> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;
        nextEvent ??= events.next();
        const heartbeat = new Promise<{ kind: 'heartbeat' }>((resolve) => {
          heartbeatTimer = setTimeout(
            () => resolve({ kind: 'heartbeat' }),
            heartbeatIntervalMs,
          );
        });
        const next = await Promise.race([
          nextEvent.then((result) => ({ kind: 'event' as const, result })),
          heartbeat,
        ]);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
        if (cancelled) return;
        if (next.kind === 'heartbeat') {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          return;
        }
        nextEvent = null;
        if (next.result.done) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(next.result.value)}\n\n`),
        );
      },
      async cancel() {
        cancelled = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        await events.return?.();
      },
    },
    { highWaterMark: 1 },
  );
};

export const GET = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return Response.json(
      { error: 'Invalid origin.', code: 'scope-denied' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return Response.json(
      { error: 'Unauthorized.', code: 'needs-sign-in' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  const operationId = getOperationId(request);
  const operationHeaders = getOperationHeaders(request);
  if (!operationId || !operationHeaders)
    return Response.json(
      { error: 'Invalid dictation event request.', code: 'invalid-input' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  try {
    const events = getDictationEvents(currentUser.userId, {
      operationId,
      ...operationHeaders,
    });
    return new Response(createEventStream(events), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
};
