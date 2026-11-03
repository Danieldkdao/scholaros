import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  activityCandidateSchema,
  type ActivityCandidate,
} from '@scholaros/services/learning/activity-contracts';

export const activityCandidateByteLimit = 512 * 1024;
export const acceptedActivityBundleByteLimit = 2 * 1024 * 1024;

export type ActivityValidationFailure = {
  ok: false;
  reason:
    | 'invalid-input'
    | 'limit-exceeded'
    | 'unsafe-content'
    | 'non-interactive'
    | 'cancelled';
};

export type ValidatedActivityCandidate = {
  ok: true;
  candidate: ActivityCandidate;
  serializedCandidate: string;
  contentDigest: string;
  byteLength: number;
};

export type ActivityValidationResult =
  | ValidatedActivityCandidate
  | ActivityValidationFailure;

type WorkerInspection = {
  ok: boolean;
  reason?: 'unsafe-content' | 'non-interactive' | 'limit-exceeded';
};

// Static checks supplement the isolated runtime; they do not make code trusted.
const inspectionWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const blockedTags = new Set([
  'base', 'embed', 'form', 'frame', 'frameset', 'iframe', 'link', 'meta', 'object',
  'portal', 'script', 'foreignobject', 'audio', 'video',
]);
const urlAttributes = new Set([
  'action', 'background', 'cite', 'data', 'download', 'dynsrc', 'formaction', 'lowsrc', 'ping', 'poster', 'src', 'srcset', 'xlink:href',
]);
const unsafeCssPatterns = [
  /@import\\b/i,
  /url\\s*\\(/i,
  /expression\\s*\\(/i,
  /-moz-binding/i,
  /behavior\\s*:/i,
  /(?:^|[;{])\\s*(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|content-visibility\\s*:\\s*hidden)(?:\\s*[;} ]|$)/i,
  /(?:^|[;{])\\s*opacity\\s*:\\s*0(?:\\s*[;} ]|$)/i,
];
const unsafeJavaScriptPatterns = [
  /\\b(?:import|export)\\s*(?:\\(|[{*'"])/,
  /\\b(?:eval|Function|Worker|SharedWorker|WebAssembly|fetch|XMLHttpRequest|WebSocket|EventSource|navigator|location|globalThis|self|parent|top|opener|process|require|module|localStorage|sessionStorage|indexedDB|Notification|postMessage|defaultView|cookie|domain|alert|confirm|prompt|print|open|close|FileReader|FileSystem|showOpenFilePicker|showSaveFilePicker|RTCPeerConnection|RTCDataChannel|RTCIceCandidate|WebTransport|importScripts|sendBeacon)\\b/,
  /\\b(?:atob|btoa|unescape|fromCharCode|fromCodePoint)\\s*\\(/,
  /\\.(?:innerHTML|outerHTML|write)\\b/,
  /\\b(?:constructor|__proto__|prototype)\\b/,
  /\\b(?:https?|wss?|file|ftp):\\/\\//i,
  /createElement(?:NS)?\\s*\\(\\s*['"]script['"]/i,
];
const cssIsSafe = (value) =>
  !unsafeCssPatterns.some((pattern) => pattern.test(value));
const javascriptIsSafe = (value) =>
  !unsafeJavaScriptPatterns.some((pattern) => pattern.test(value));

void import(pathToFileURL(workerData.parse5Entry).href).then(({ parseFragment }) => {
  const root = parseFragment(workerData.html);
  let nodeCount = 0;
  let controlCount = 0;
  let hasVisualization = false;
  let hasLiveRegion = false;
  let styleText = '';
  let unsafe = false;
  const walk = (node) => {
    nodeCount += 1;
    if (nodeCount > 20000) return;
    const tagName = node.tagName?.toLowerCase();
    if (tagName && blockedTags.has(tagName)) unsafe = true;
    if (tagName && ['button', 'input', 'select', 'textarea'].includes(tagName)) {
      if (tagName === 'input' && node.attrs?.some((attribute) => attribute.name.toLowerCase() === 'type' && attribute.value.toLowerCase() === 'file'))
        unsafe = true;
      if (!node.attrs?.some((attribute) => attribute.name.toLowerCase() === 'disabled'))
        controlCount += 1;
    }
    if (tagName === 'svg' || tagName === 'canvas') hasVisualization = true;
    if (tagName === 'style')
      styleText += (node.childNodes ?? []).map((child) => child.value ?? '').join('');
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith('on') ||
        urlAttributes.has(name) ||
        name === 'hidden' ||
        (name === 'aria-hidden' && value.toLowerCase() === 'true') ||
        /^data-(?:answer|solution|correct|key)$/i.test(name)
      )
        unsafe = true;
      if (name === 'href' && value && !value.startsWith('#')) unsafe = true;
      if (name === 'style' && !cssIsSafe(value)) unsafe = true;
      if (name === 'aria-live') hasLiveRegion = true;
    }
    const children = [
      ...(node.childNodes ?? []),
      ...(node.content?.childNodes ?? []),
    ];
    for (const child of children) walk(child);
  };
  walk(root);
  if (nodeCount > 20000) {
    parentPort.postMessage({ ok: false, reason: 'limit-exceeded' });
    return;
  }
  if (
    unsafe ||
    !cssIsSafe(workerData.css) ||
    !cssIsSafe(styleText) ||
    !javascriptIsSafe(workerData.javascript)
  ) {
    parentPort.postMessage({ ok: false, reason: 'unsafe-content' });
    return;
  }
  const hasEventHandler = /\\baddEventListener\\s*\\(|\\bon(?:click|input|change|submit)\\s*=/i.test(workerData.javascript);
  const updatesFeedback = /\\.(?:textContent|innerText|value|setAttribute|appendChild|replaceChildren)\\b/i.test(workerData.javascript);
  const updatesVisualization =
    /\\.setAttribute\\s*\\(\\s*['"](?:d|points|viewBox|cx|cy|r|x|y|x1|x2|y1|y2|fill|stroke|width|height)['"]/i.test(workerData.javascript) ||
    /\\.(?:clearRect|fillRect|strokeRect|beginPath|lineTo|moveTo|arc|putImageData|drawImage)\\s*\\(/.test(workerData.javascript);
  if (
    controlCount === 0 ||
    !hasEventHandler ||
    (!updatesFeedback && !hasLiveRegion) ||
    (hasVisualization && !updatesVisualization)
  ) {
    parentPort.postMessage({ ok: false, reason: 'non-interactive' });
    return;
  }
  parentPort.postMessage({ ok: true });
}).catch(() => {
  parentPort.postMessage({ ok: false, reason: 'unsafe-content' });
});
`;

const resolveParse5Entry = () => {
  const callerPath =
    typeof __filename === 'string'
      ? __filename
      : join(process.cwd(), 'package.json');
  return createRequire(callerPath).resolve('parse5');
};

const inspectCandidateInWorker = (
  candidate: ActivityCandidate,
  signal?: AbortSignal,
): Promise<WorkerInspection> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'limit-exceeded' });
      return;
    }

    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(inspectionWorkerSource, {
        eval: true,
        workerData: {
          parse5Entry: resolveParse5Entry(),
          html: candidate.html,
          css: candidate.css,
          javascript: candidate.javascript,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 2,
        },
      });
    } catch {
      resolve({ ok: false, reason: 'unsafe-content' });
      return;
    }
    const timeout = setTimeout(
      () => finish({ ok: false, reason: 'limit-exceeded' }),
      2500,
    );
    const onAbort = () => finish({ ok: false, reason: 'limit-exceeded' });
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (result: WorkerInspection) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      resolve(result);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (result: WorkerInspection) => finish(result));
    worker.once('error', () => finish({ ok: false, reason: 'unsafe-content' }));
    worker.once('exit', (code) => {
      if (code !== 0) finish({ ok: false, reason: 'unsafe-content' });
    });
  });

export const validateActivityCandidate = async (
  input: unknown,
  signal?: AbortSignal,
): Promise<ActivityValidationResult> => {
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, reason: 'invalid-input' };

  const source = input as Record<string, unknown>;
  const candidateStrings = [
    source.title,
    source.objective,
    source.html,
    source.css,
    source.javascript,
    source.accessibleExplanation,
  ];
  if (candidateStrings.some((value) => typeof value !== 'string'))
    return { ok: false, reason: 'invalid-input' };
  const stringBytes = candidateStrings.reduce<number>(
    (total, value) => total + Buffer.byteLength(value as string, 'utf8'),
    0,
  );
  if (stringBytes > activityCandidateByteLimit)
    return { ok: false, reason: 'limit-exceeded' };

  let parsed: ReturnType<typeof activityCandidateSchema.safeParse>;
  try {
    parsed = activityCandidateSchema.safeParse(input);
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
  if (!parsed.success) return { ok: false, reason: 'invalid-input' };

  const candidate = parsed.data;
  if (
    !candidate.title.trim() ||
    !candidate.objective.trim() ||
    !candidate.html.trim() ||
    !candidate.javascript.trim() ||
    !candidate.accessibleExplanation.trim()
  )
    return { ok: false, reason: 'invalid-input' };

  let serializedCandidate: string;
  try {
    serializedCandidate = JSON.stringify(candidate);
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
  const byteLength = Buffer.byteLength(serializedCandidate, 'utf8');
  if (byteLength > activityCandidateByteLimit)
    return { ok: false, reason: 'limit-exceeded' };

  const inspection = await inspectCandidateInWorker(candidate, signal);
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  if (!inspection.ok)
    return {
      ok: false,
      reason: inspection.reason ?? 'unsafe-content',
    };

  return {
    ok: true,
    candidate,
    serializedCandidate,
    contentDigest: createHash('sha256')
      .update(serializedCandidate)
      .digest('hex'),
    byteLength,
  };
};
