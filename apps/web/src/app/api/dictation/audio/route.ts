import {
  appendDictationAudio,
  DictationError,
} from '@scholaros/services/ai/dictation';
import {
  idSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';

export const runtime = 'nodejs';
const maxFrameBytes = 16_384;
const noStoreHeaders = { 'Cache-Control': 'no-store' };

const readBoundedBytes = async (request: Request, limit: number) => {
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
};

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
  const composerRevision = Number(composerRevisionHeader);
  const parsedRevision = revisionSchema.safeParse(composerRevision);
  if (!parsedRevision.success) return null;
  return { sessionId, composerRevision: parsedRevision.data };
};

const errorResponse = (error: unknown) => {
  if (error instanceof DictationError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders },
    );
  console.error('[api/dictation] request failed', {
    kind: 'audio',
    name: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json(
    { error: 'Meta dictation could not finish.', code: 'provider-failed' },
    { status: 502, headers: noStoreHeaders },
  );
};

export const PUT = async (request: Request) => {
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
    'application/octet-stream'
  )
    return Response.json(
      { error: 'Expected a PCM audio frame.', code: 'invalid-input' },
      { status: 415, headers: noStoreHeaders },
    );
  const operationId = getOperationId(request);
  const operationHeaders = getOperationHeaders(request);
  const sequenceHeader = request.headers.get('x-dictation-sequence');
  if (
    !operationId ||
    !operationHeaders ||
    !sequenceHeader ||
    !/^(0|[1-9]\d*)$/.test(sequenceHeader)
  )
    return Response.json(
      { error: 'Invalid dictation audio request.', code: 'invalid-input' },
      { status: 400, headers: noStoreHeaders },
    );
  const sequence = Number(sequenceHeader);
  if (!revisionSchema.safeParse(sequence).success)
    return Response.json(
      { error: 'Invalid dictation audio sequence.', code: 'invalid-input' },
      { status: 400, headers: noStoreHeaders },
    );

  let bytes: Uint8Array | null = null;
  try {
    bytes = await readBoundedBytes(request, maxFrameBytes);
    if (bytes === null)
      return Response.json(
        {
          error: 'Dictation audio frame exceeds 16 KiB.',
          code: 'limit-exceeded',
        },
        { status: 413, headers: noStoreHeaders },
      );
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0)
      return Response.json(
        {
          error: 'PCM audio frame must contain whole samples.',
          code: 'invalid-input',
        },
        { status: 400, headers: noStoreHeaders },
      );
    const result = await appendDictationAudio(currentUser.userId, {
      operationId,
      ...operationHeaders,
      sequence,
      bytes,
    });
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    return errorResponse(error);
  } finally {
    bytes?.fill(0);
  }
};
