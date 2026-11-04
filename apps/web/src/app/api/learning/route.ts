import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import { generateActivityCandidate } from '../../../../../../packages/services/src/ai/activity-generation';
import {
  LearningDispatchError,
  createLearningDispatcher,
  learningOperationResponseSchema,
  learningRequestSchema,
  type LearningCapabilities,
  type LearningRequest,
} from '../../../../../../packages/services/src/ai/learning-dispatch';
import {
  assessPracticeCandidateForLearning,
  assessTutorCandidate,
  evaluatePracticeAnswerForLearning,
  generatePracticeCandidateForLearning,
  generateTutorCandidate,
  getLearningCapabilities,
} from '../../../../../../packages/services/src/ai/tutor';

export const runtime = 'nodejs';
export const learningRequestByteLimit = 96 * 1024;
const requestWindowMs = 60_000;
const requestsPerWindow = 30;
const maxConcurrentRequests = 2;
type CurrentUser = { userId: string | null } | null;
type LearningPostDependencies = {
  getCurrentUser: (headers: Headers) => Promise<CurrentUser>;
  trustedOrigin: string;
  getCapabilities: () => Promise<LearningCapabilities>;
  handleLearningRequest: (
    userId: string,
    input: LearningRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  now?: () => number;
};
type RequestBudget = { since: number; count: number; inFlight: number };
const noStore = { 'Cache-Control': 'no-store' };
const jsonError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: noStore });
const readBoundedBody = async (
  request: Request,
  limit: number,
  signal: AbortSignal,
) => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
      return { kind: 'invalid' as const };
    if (declaredLength > limit) return { kind: 'too-large' as const };
  }
  if (signal.aborted) return { kind: 'cancelled' as const };
  if (!request.body) return { kind: 'ok' as const, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  try {
    if (signal.aborted) return { kind: 'cancelled' as const };
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { kind: 'cancelled' as const };
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' as const };
      }
      chunks.push(value);
    }
  } catch {
    return signal.aborted
      ? { kind: 'cancelled' as const }
      : { kind: 'invalid' as const };
  } finally {
    signal.removeEventListener('abort', cancelRead);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      kind: 'ok' as const,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: 'invalid' as const };
  }
};
const statusForDispatchError = (code: LearningDispatchError['code']) => {
  switch (code) {
    case 'invalid-input':
      return 400;
    case 'scope-denied':
      return 403;
    case 'revision-conflict':
    case 'capability-changed':
      return 409;
    case 'limit-exceeded':
      return 413;
    case 'unsupported':
      return 415;
    case 'unreadable':
      return 422;
    case 'cancelled':
      return 408;
    case 'feature-unavailable':
      return 503;
    case 'provider-failed':
      return 502;
  }
};
const messageForDispatchError = (code: LearningDispatchError['code']) => {
  switch (code) {
    case 'invalid-input':
      return 'The learning request is invalid.';
    case 'scope-denied':
      return 'This learning request is not allowed.';
    case 'revision-conflict':
      return 'The request ID was already used with different content.';
    case 'capability-changed':
      return 'The learning capability changed; restart this request.';
    case 'limit-exceeded':
      return 'The learning request exceeds its limit.';
    case 'unsupported':
      return 'This document type is not supported.';
    case 'unreadable':
      return 'The document could not be read.';
    case 'cancelled':
      return 'The learning request was cancelled.';
    case 'feature-unavailable':
      return 'The selected learning capability is unavailable.';
    case 'provider-failed':
      return 'The learning request could not finish. Try again.';
  }
};

export const createLearningPostHandler = (
  dependencies: LearningPostDependencies,
) => {
  const now = dependencies.now ?? Date.now;
  const budgets = new Map<string, RequestBudget>();
  return async (request: Request) => {
    const origin = request.headers.get('origin');
    if (origin && origin !== dependencies.trustedOrigin)
      return jsonError(
        403,
        'scope-denied',
        'The request origin is not allowed.',
      );
    const currentUser = await dependencies.getCurrentUser(request.headers);
    if (!currentUser?.userId)
      return jsonError(401, 'needs-sign-in', 'Sign in to use learning tools.');
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(60_000),
    ]);
    const contentType = request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json')
      return jsonError(415, 'unsupported', 'Send a JSON learning request.');
    const body = await readBoundedBody(
      request,
      learningRequestByteLimit,
      signal,
    );
    if (body.kind === 'cancelled')
      return jsonError(
        408,
        'cancelled',
        'The learning request was cancelled or timed out.',
      );
    if (body.kind === 'too-large')
      return jsonError(
        413,
        'limit-exceeded',
        'The learning request is too large.',
      );
    if (body.kind === 'invalid')
      return jsonError(
        400,
        'invalid-input',
        'The learning request is invalid.',
      );
    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(body.text);
    } catch {
      return jsonError(
        400,
        'invalid-input',
        'The learning request is invalid.',
      );
    }
    const parsedRequest = learningRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success)
      return jsonError(
        400,
        'invalid-input',
        'The learning request is invalid.',
      );
    if (signal.aborted)
      return jsonError(
        408,
        'cancelled',
        'The learning request was cancelled or timed out.',
      );
    let capabilities: LearningCapabilities;
    try {
      capabilities = await dependencies.getCapabilities();
    } catch {
      return jsonError(
        503,
        'feature-unavailable',
        'The learning capability is unavailable.',
      );
    }
    if (capabilities.tutor !== 'available')
      return jsonError(
        503,
        'feature-unavailable',
        'The learning capability is unavailable.',
      );
    const currentTime = now();
    for (const [userId, budget] of budgets)
      if (currentTime - budget.since >= requestWindowMs) budgets.delete(userId);
    const budget = budgets.get(currentUser.userId) ?? {
      since: currentTime,
      count: 0,
      inFlight: 0,
    };
    if (
      budget.count >= requestsPerWindow ||
      budget.inFlight >= maxConcurrentRequests
    )
      return jsonError(
        429,
        'rate-limited',
        'The learning request limit was reached.',
      );
    budgets.set(currentUser.userId, {
      ...budget,
      count: budget.count + 1,
      inFlight: budget.inFlight + 1,
    });
    try {
      const learningResponse = await dependencies.handleLearningRequest(
        currentUser.userId,
        parsedRequest.data,
        signal,
      );
      signal.throwIfAborted();
      const parsedResponse =
        learningOperationResponseSchema.safeParse(learningResponse);
      if (!parsedResponse.success)
        return jsonError(
          502,
          'provider-failed',
          'The learning response could not be validated.',
        );
      const response = parsedResponse.data;
      const operationMatches =
        'kind' in response
          ? response.kind === parsedRequest.data.kind
          : parsedRequest.data.kind !== 'practice-generate' &&
            parsedRequest.data.kind !== 'practice-evaluate';
      if (
        response.requestId !== parsedRequest.data.requestId ||
        !operationMatches
      )
        return jsonError(
          502,
          'provider-failed',
          'The learning response could not be validated.',
        );
      return Response.json(response, { headers: noStore });
    } catch (error) {
      if (signal.aborted)
        return jsonError(
          408,
          'cancelled',
          'The learning request was cancelled or timed out.',
        );
      if (error instanceof LearningDispatchError)
        return jsonError(
          statusForDispatchError(error.code),
          error.code,
          messageForDispatchError(error.code),
        );
      console.error('[api/learning] request failed', {
        kind: parsedRequest.data.kind,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonError(
        502,
        'provider-failed',
        'The learning request could not finish. Try again.',
      );
    } finally {
      const currentBudget = budgets.get(currentUser.userId);
      if (currentBudget)
        budgets.set(currentUser.userId, {
          ...currentBudget,
          inFlight: Math.max(0, currentBudget.inFlight - 1),
        });
    }
  };
};

const dispatcher = createLearningDispatcher({
  practiceProofSecret: () => serverEnv.BETTER_AUTH_SECRET,
  getCapabilities: getLearningCapabilities,
  generateCandidate: generateTutorCandidate,
  operations: {
    'activity-generate': async (request, signal) => {
      if (request.kind !== 'activity-generate')
        throw new LearningDispatchError('invalid-input');
      const offeredSources = request.input.sources.map(
        (source) => source.reference,
      );
      const candidate = await generateActivityCandidate(
        {
          objective: request.input.objective,
          sourceReferences: offeredSources,
          context: request.input.sources
            .map((source) => source.text)
            .join('\n\n')
            .slice(0, 24_000),
        },
        signal,
      );
      return {
        candidate: {
          text: candidate.accessibleExplanation,
          citationIndexes: offeredSources.map((_source, index) => index),
          proposedEffects: [{ kind: 'create-activity', candidate }],
        },
        offeredSources,
      };
    },
    'practice-generate': generatePracticeCandidateForLearning,
    'practice-evaluate': evaluatePracticeAnswerForLearning,
  },
  assessCandidate: assessTutorCandidate,
  assessPracticeCandidate: assessPracticeCandidateForLearning,
});
export const POST = createLearningPostHandler({
  getCurrentUser,
  trustedOrigin: new URL(serverEnv.BETTER_AUTH_URL).origin,
  getCapabilities: getLearningCapabilities,
  handleLearningRequest: dispatcher.dispatch,
});
