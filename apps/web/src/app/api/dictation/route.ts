import {
  cancelDictation,
  createDictation,
  DictationError,
} from '@scholaros/services/ai/dictation';
import { dictationStartInputSchema } from '@scholaros/services/learning/speech-contracts';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import { z } from 'zod';

export const runtime = 'nodejs';
const requestBodyLimit = 4_096;
const noStoreHeaders = { 'Cache-Control': 'no-store' };
const startRequestSchema = dictationStartInputSchema.extend({
  version: z.literal(1),
});
export type StartRequestSchema = z.infer<typeof startRequestSchema>;
type StartRequest = z.infer<typeof startRequestSchema>;

const readBoundedBody = async (request: Request, limit: number) => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
      return null;
    if (declaredLength > limit) {
      await request.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      for (const chunk of chunks) chunk.fill(0);
      value.fill(0);
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    chunk.fill(0);
    offset += chunk.byteLength;
  }
  return bytes;
};

const errorResponse = (error: unknown) => {
  if (error instanceof DictationError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders },
    );
  console.error('[api/dictation] request failed', {
    kind: 'start',
    name: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json(
    { error: 'Meta dictation could not finish.', code: 'provider-failed' },
    { status: 502, headers: noStoreHeaders },
  );
};

export const POST = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return Response.json(
      { error: 'Invalid origin.', code: 'scope-denied' },
      { status: 403, headers: noStoreHeaders },
    );
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return Response.json(
      { error: 'Unauthorized.', code: 'needs-sign-in' },
      { status: 401, headers: noStoreHeaders },
    );
  if (
    request.headers.get('content-type')?.split(';', 1)[0].trim() !==
    'application/json'
  )
    return Response.json(
      { error: 'Expected a JSON dictation request.', code: 'invalid-input' },
      { status: 415, headers: noStoreHeaders },
    );

  let bytes: Uint8Array | null = null;
  try {
    bytes = await readBoundedBody(request, requestBodyLimit);
    if (bytes === null)
      return Response.json(
        { error: 'Dictation request is too large.', code: 'limit-exceeded' },
        { status: 413, headers: noStoreHeaders },
      );
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      return Response.json(
        { error: 'Invalid dictation request.', code: 'invalid-input' },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const parsed = startRequestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: 'Invalid dictation request.', code: 'invalid-input' },
        { status: 400, headers: noStoreHeaders },
      );
    const input = {
      sessionId: parsed.data.sessionId,
      requestId: parsed.data.requestId,
      composerRevision: parsed.data.composerRevision,
    } satisfies Omit<StartRequest, 'version'>;
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(15_000),
    ]);
    const operation = await createDictation(currentUser.userId, input, signal);
    if (request.signal.aborted) {
      await cancelDictation(currentUser.userId, {
        operationId: operation.operationId,
        sessionId: input.sessionId,
        composerRevision: input.composerRevision,
      }).catch(() => undefined);
      return Response.json(
        { error: 'Dictation was cancelled.', code: 'cancelled' },
        { status: 409, headers: noStoreHeaders },
      );
    }
    return Response.json(operation, { headers: noStoreHeaders });
  } catch (error) {
    return errorResponse(error);
  } finally {
    bytes?.fill(0);
  }
};
