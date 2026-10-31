import { isInferenceConfigured } from '@scholaros/services/ai/models/inference';
import { resolveConnectionRequests } from '@scholaros/services/ai/connection-resolver';
import { classifyCourseTargets } from '@scholaros/services/ai/course-discovery';
import {
  chooseAcademicTarget,
  extractAcademicEvidence,
} from '@scholaros/services/ai/academic';
import {
  agentRequestSchema,
  connectionResolveRequestSchema,
  type RequestKind,
} from '@scholaros/services/ai/schemas';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';

export const runtime = 'nodejs';
const requestBodyLimit = 150_000;
const requestBudgets = new Map<string, { since: number; count: number }>();

const readBoundedText = async (request: Request, limit: number) => {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > limit) return null;
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
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export const POST = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const now = Date.now();
  for (const [id, budget] of requestBudgets)
    if (now - budget.since > 3_600_000) requestBudgets.delete(id);
  const budget = requestBudgets.get(currentUser.userId) ?? {
    since: now,
    count: 0,
  };
  if (budget.count >= 120)
    return Response.json(
      { error: 'Preview limit reached; try again later.' },
      { status: 429 },
    );
  requestBudgets.set(currentUser.userId, {
    since: budget.since,
    count: budget.count + 1,
  });
  let requestKind = 'unrecognized';
  try {
    const text = await readBoundedText(request, requestBodyLimit);
    if (text === null)
      return Response.json(
        { error: 'Preview context is too large.' },
        { status: 413 },
      );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json(
        { error: 'Invalid preview request.' },
        { status: 400 },
      );
    }
    const resolution = connectionResolveRequestSchema.safeParse(body);
    if (resolution.success) {
      requestKind = 'resolve';
      if (!isInferenceConfigured())
        return Response.json(
          { error: 'The connection assistant is unavailable.' },
          { status: 503 },
        );
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(25_000),
      ]);
      const result = await resolveConnectionRequests(
        resolution.data.prompt,
        signal,
      );
      return Response.json(result, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const parsed = agentRequestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { error: 'Invalid preview request.' },
        { status: 400 },
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25_000),
    ]);
    const kind: RequestKind = parsed.data.kind;
    requestKind = kind;
    if (!isInferenceConfigured())
      return Response.json(
        { error: 'The AI assistant is unavailable.' },
        { status: 503 },
      );
    const result =
      kind === 'choose'
        ? await chooseAcademicTarget(parsed.data, signal)
        : kind === 'discover'
          ? await classifyCourseTargets(parsed.data, signal)
          : await extractAcademicEvidence(parsed.data, signal);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // The provider's own failure text stays out of the response, so it has to
    // reach the server log or nothing is diagnosable.
    console.error('[api/agent] request failed', { kind: requestKind, error });
    return Response.json(
      { error: 'The AI request could not finish. Try again.' },
      { status: 502 },
    );
  }
};
