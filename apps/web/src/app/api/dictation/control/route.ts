import {
  cancelDictation,
  dictationControlActions,
  DictationError,
  stopDictation,
} from '@scholaros/services/ai/dictation';
import {
  idSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import { z } from 'zod';

export const runtime = 'nodejs';
const requestBodyLimit = 4_096;
const noStoreHeaders = { 'Cache-Control': 'no-store' };
const controlRequestSchema = z.strictObject({
  operationId: idSchema,
  action: z.enum(dictationControlActions),
});
type ControlRequest = z.infer<typeof controlRequestSchema>;

const readBoundedText = async (request: Request, limit: number) => {
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
  if (!request.body) return '';
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
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

const getDeleteOperationId = (request: Request) => {
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

const errorResponse = (error: unknown, kind: string) => {
  if (error instanceof DictationError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders },
    );
  console.error('[api/dictation] request failed', {
    kind,
    name: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json(
    { error: 'Meta dictation could not finish.', code: 'provider-failed' },
    { status: 502, headers: noStoreHeaders },
  );
};

const checkRequest = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return {
      response: Response.json(
        { error: 'Invalid origin.', code: 'scope-denied' },
        { status: 403, headers: noStoreHeaders },
      ),
    };
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return {
      response: Response.json(
        { error: 'Unauthorized.', code: 'needs-sign-in' },
        { status: 401, headers: noStoreHeaders },
      ),
    };
  return { userId: currentUser.userId };
};

const runControl = async (
  userId: string,
  input: ControlRequest,
  operationHeaders: { sessionId: string; composerRevision: number },
) => {
  const operation = {
    operationId: input.operationId,
    ...operationHeaders,
  };
  const action = input.action;
  if (action === 'stop') await stopDictation(userId, operation);
  else await cancelDictation(userId, operation);
  return Response.json(
    { operationId: input.operationId },
    { headers: noStoreHeaders },
  );
};

export const POST = async (request: Request) => {
  const authentication = await checkRequest(request);
  if ('response' in authentication) return authentication.response;
  if (
    request.headers.get('content-type')?.split(';', 1)[0].trim() !==
    'application/json'
  )
    return Response.json(
      {
        error: 'Expected a JSON dictation control request.',
        code: 'invalid-input',
      },
      { status: 415, headers: noStoreHeaders },
    );
  const operationHeaders = getOperationHeaders(request);
  if (!operationHeaders)
    return Response.json(
      { error: 'Invalid dictation session headers.', code: 'invalid-input' },
      { status: 400, headers: noStoreHeaders },
    );

  try {
    const bodyText = await readBoundedText(request, requestBodyLimit);
    if (bodyText === null)
      return Response.json(
        {
          error: 'Dictation control request is too large.',
          code: 'limit-exceeded',
        },
        { status: 413, headers: noStoreHeaders },
      );
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return Response.json(
        { error: 'Invalid dictation control request.', code: 'invalid-input' },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const parsed = controlRequestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: 'Invalid dictation control request.', code: 'invalid-input' },
        { status: 400, headers: noStoreHeaders },
      );
    return await runControl(
      authentication.userId,
      parsed.data,
      operationHeaders,
    );
  } catch (error) {
    return errorResponse(error, 'control');
  }
};

export const DELETE = async (request: Request) => {
  const authentication = await checkRequest(request);
  if ('response' in authentication) return authentication.response;
  const operationId = getDeleteOperationId(request);
  const operationHeaders = getOperationHeaders(request);
  if (!operationId || !operationHeaders)
    return Response.json(
      {
        error: 'Invalid dictation cancellation request.',
        code: 'invalid-input',
      },
      { status: 400, headers: noStoreHeaders },
    );
  try {
    await cancelDictation(authentication.userId, {
      operationId,
      ...operationHeaders,
    });
    return Response.json({ operationId }, { headers: noStoreHeaders });
  } catch (error) {
    return errorResponse(error, 'cancel');
  }
};
