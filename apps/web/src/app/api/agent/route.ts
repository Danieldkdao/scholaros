import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import { browserNavigationModeSchema } from '@scholaros/env/browser-navigation';
import {
  getModelCapabilities,
  type ModelCapabilityOperation,
} from '@scholaros/services/ai/models/inference';
import { resolveConnectionRequests } from '@scholaros/services/ai/connection-resolver';
import { classifyCourseTargets } from '@scholaros/services/ai/course-discovery';
import {
  chooseAcademicTarget,
  extractAcademicEvidence,
} from '@scholaros/services/ai/academic';
import {
  browserAgentRequestSchema,
  connectionResolveRequestSchema,
  type RequestKind,
} from '@scholaros/services/ai/schemas';
import {
  generateBrowserModel,
  getBrowserModelOperation,
} from '@scholaros/services/ai/browser-model';
import { browserModelRequestSchema } from '@scholaros/services/ai/browser-schemas';

export const runtime = 'nodejs';
const requestBodyLimit = 150_000;
const requestWindowMs = 60_000;
const requestBudgets = new Map<string, { since: number; count: number }>();

const noStoreJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });

const capabilityChanged = () =>
  noStoreJson(
    {
      error: 'Browser capability changed; restart this operation.',
      code: 'capability-changed',
    },
    409,
  );

const unavailable = () =>
  noStoreJson(
    {
      error: 'The configured model cannot perform this operation.',
      code: 'feature-unavailable',
    },
    503,
  );

const getAgentOperation = (kind: RequestKind): ModelCapabilityOperation => {
  switch (kind) {
    case 'choose':
      return 'decision-navigation';
    case 'discover':
      return 'course-discovery';
    case 'courses':
    case 'assignments':
    case 'announcements':
    case 'materials':
      return 'resource-extraction';
  }
};

const isAgentOperationCompatible = (
  operation: ModelCapabilityOperation,
  mode: 'decision' | 'inout',
) => {
  switch (operation) {
    case 'decision-navigation':
    case 'course-discovery':
    case 'resource-extraction':
      return mode === 'decision';
    case 'connection-resolution':
    case 'browser-navigation':
    case 'browser-extraction':
    case 'learning-text':
    case 'learning-activity':
    case 'learning-practice':
    case 'learning-memory':
    case 'material-image':
    case 'material-pdf':
      return false;
  }
};

const isBrowserModelOperationCompatible = (
  operation: ModelCapabilityOperation,
  mode: 'decision' | 'inout',
) => {
  switch (operation) {
    case 'browser-navigation':
    case 'browser-extraction':
    case 'course-discovery':
      return mode === 'inout';
    case 'connection-resolution':
    case 'decision-navigation':
    case 'resource-extraction':
    case 'learning-text':
    case 'learning-activity':
    case 'learning-practice':
    case 'learning-memory':
    case 'material-image':
    case 'material-pdf':
      return false;
  }
};

export const GET = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return noStoreJson(
      { error: 'Invalid origin', code: 'invalid-origin' },
      403,
    );
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return noStoreJson({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  const mode = browserNavigationModeSchema.safeParse(serverEnv.BROWSER_NAV);
  if (!mode.success)
    return noStoreJson(
      { error: 'Browser navigation mode is misconfigured.' },
      500,
    );
  return noStoreJson({
    browserNavigationMode: mode.data,
    modelCapabilities: getModelCapabilities(),
  });
};

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
    return noStoreJson(
      { error: 'Invalid origin', code: 'invalid-origin' },
      403,
    );
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return noStoreJson({ error: 'Unauthorized', code: 'unauthorized' }, 401);

  const now = Date.now();
  for (const [id, budget] of requestBudgets)
    if (now - budget.since >= requestWindowMs) requestBudgets.delete(id);
  const budget = requestBudgets.get(currentUser.userId) ?? {
    since: now,
    count: 0,
  };
  if (budget.count >= 120)
    return noStoreJson(
      {
        error: 'Academic service request limit reached; try again later.',
        code: 'rate-limited',
      },
      429,
    );
  requestBudgets.set(currentUser.userId, {
    since: budget.since,
    count: budget.count + 1,
  });

  let requestKind = 'unrecognized';
  try {
    const text = await readBoundedText(request, requestBodyLimit);
    if (text === null)
      return noStoreJson(
        { error: 'Preview context is too large.', code: 'request-too-large' },
        413,
      );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return noStoreJson(
        { error: 'Invalid preview request.', code: 'invalid-request' },
        400,
      );
    }

    const resolution = connectionResolveRequestSchema.safeParse(body);
    if (resolution.success) {
      requestKind = 'resolve';
      const capabilities = getModelCapabilities();
      if (!capabilities.operations['connection-resolution'])
        return unavailable();
      const configurationRevision = capabilities.configurationRevision;
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(25_000),
      ]);
      const result = await resolveConnectionRequests(
        resolution.data.prompt,
        signal,
      );
      if (
        getModelCapabilities().configurationRevision !== configurationRevision
      )
        return capabilityChanged();
      return noStoreJson(result);
    }

    const browserModel = browserModelRequestSchema.safeParse(body);
    if (browserModel.success) {
      requestKind = 'browser-model';
      const selectedMode = browserNavigationModeSchema.safeParse(
        serverEnv.BROWSER_NAV,
      );
      if (!selectedMode.success)
        return noStoreJson(
          { error: 'Browser navigation mode is misconfigured.' },
          500,
        );
      const requestedMode = browserModel.data.browserNavigationMode ?? 'inout';
      if (requestedMode !== selectedMode.data || requestedMode !== 'inout')
        return capabilityChanged();
      const operation = getBrowserModelOperation(browserModel.data);
      if (!operation)
        return noStoreJson(
          { error: 'Invalid browser model request.', code: 'invalid-request' },
          400,
        );
      if (!isBrowserModelOperationCompatible(operation, selectedMode.data))
        return capabilityChanged();
      const capabilities = getModelCapabilities();
      if (!capabilities.operations[operation]) return unavailable();
      if (
        browserModel.data.configurationRevision &&
        browserModel.data.configurationRevision !==
          capabilities.configurationRevision
      )
        return capabilityChanged();
      const configurationRevision = capabilities.configurationRevision;
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(60_000),
      ]);
      const result = await generateBrowserModel(browserModel.data, signal);
      if (
        getModelCapabilities().configurationRevision !== configurationRevision
      )
        return capabilityChanged();
      return noStoreJson(result);
    }

    const parsed = browserAgentRequestSchema.safeParse(body);
    if (!parsed.success)
      return noStoreJson(
        { error: 'Invalid preview request.', code: 'invalid-request' },
        400,
      );
    const kind: RequestKind = parsed.data.kind;
    requestKind = kind;
    const selectedMode = browserNavigationModeSchema.safeParse(
      serverEnv.BROWSER_NAV,
    );
    if (!selectedMode.success)
      return noStoreJson(
        { error: 'Browser navigation mode is misconfigured.' },
        500,
      );
    const operation = getAgentOperation(kind);
    if (
      parsed.data.browserNavigationMode !== selectedMode.data ||
      !isAgentOperationCompatible(operation, selectedMode.data)
    )
      return capabilityChanged();
    const capabilities = getModelCapabilities();
    if (!capabilities.operations[operation]) return unavailable();
    if (
      parsed.data.configurationRevision &&
      parsed.data.configurationRevision !== capabilities.configurationRevision
    )
      return capabilityChanged();
    const configurationRevision = capabilities.configurationRevision;
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(
        kind === 'choose' || kind === 'discover' ? 25_000 : 60_000,
      ),
    ]);
    const result =
      kind === 'choose'
        ? await chooseAcademicTarget(parsed.data, signal)
        : kind === 'discover'
          ? await classifyCourseTargets(parsed.data, signal)
          : await extractAcademicEvidence(parsed.data, signal);
    if (getModelCapabilities().configurationRevision !== configurationRevision)
      return capabilityChanged();
    return noStoreJson(result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'ModelCapabilityUnavailableError'
    )
      return unavailable();
    if (
      error instanceof Error &&
      requestKind === 'browser-model' &&
      [
        'The Stagehand browser request uses unsupported content.',
        'The Stagehand browser response schema is unsupported.',
      ].includes(error.message)
    )
      return noStoreJson(
        { error: 'Invalid browser model request.', code: 'invalid-request' },
        400,
      );
    if (
      error instanceof Error &&
      requestKind === 'browser-model' &&
      [
        'The generated browser response did not match its schema.',
        'The generated browser response selected an unoffered target.',
      ].includes(error.message)
    )
      return noStoreJson(
        {
          error: 'The model returned an unsupported browser response.',
          code: 'model-response-invalid',
        },
        502,
      );
    console.error('[api/agent] request failed', {
      kind: requestKind,
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return noStoreJson(
      {
        error: 'The AI request could not finish. Try again.',
        code: 'provider-error',
      },
      502,
    );
  }
};
