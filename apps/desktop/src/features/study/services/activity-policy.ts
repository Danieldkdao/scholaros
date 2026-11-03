import { createHash } from 'node:crypto';
import { parseFragment, serialize } from 'parse5';

export type ActivityBundle = {
  html: string;
  css: string;
  sdk: string;
  javascript: string;
};

export type ActivityDocument = {
  body: string;
  bootstrapScript: string;
  relayScript: string;
  headers: Record<string, string>;
};

type ActivityMarkupNode = {
  tagName?: string;
  childNodes?: ActivityMarkupNode[];
  attrs?: Array<{ name: string; value: string }>;
  content?: ActivityMarkupNode;
};

const maximumBundleBytes = 512 * 1024;
const maximumDocumentBytes = 2 * 1024 * 1024;
export const activityConnectionAllowlistHeader =
  '();webrtc=block;redirects=block';
const deniedMarkupTags = new Set([
  'audio',
  'base',
  'embed',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'source',
  'track',
  'video',
]);

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export const createActivityBootstrapScript = (
  expectedNonce: string,
  expectedParentOrigin: string,
) => `(() => {
  const expectedNonce = ${JSON.stringify(expectedNonce)};
  const expectedParentOrigin = ${JSON.stringify(expectedParentOrigin)};
  const blockFileTransfer = (event) => {
    const transfer = event.clipboardData || event.dataTransfer;
    if (!transfer) return;
    const hasFile = Array.from(transfer.items || []).some((item) => item.kind === 'file') || (transfer.files && transfer.files.length > 0);
    if (!hasFile) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };
  window.addEventListener('paste', blockFileTransfer, true);
  window.addEventListener('drop', blockFileTransfer, true);
  window.parent.postMessage(JSON.stringify({ source: 'scholar-activity-frame', kind: 'frame-ready' }), '*');
  let initialized = false;
  const onHostMessage = (event) => {
    if (initialized || event.source !== window.parent || (event.origin !== expectedParentOrigin && event.origin !== 'null') || typeof event.data !== 'string' || event.data.length > 700000) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.kind !== 'activity-bootstrap' || message.source !== 'scholar-host' || message.protocolVersion !== 1 || message.runtimeVersion !== 'activity-runtime-v1' || message.nonce !== expectedNonce) return;
    initialized = true;
    window.removeEventListener('message', onHostMessage, true);
    const style = document.createElement('style');
    style.textContent = message.css;
    document.head.appendChild(style);
    Object.defineProperty(window, '__scholarActivityInitialState', { value: message.initialState, configurable: false, writable: false });
    Object.defineProperty(window, '__scholarActivityStateRevision', { value: message.stateRevision, configurable: false, writable: false });
    window.parent.postMessage(JSON.stringify({
      protocolVersion: 1,
      runtimeVersion: message.runtimeVersion,
      source: 'activity',
      sessionId: message.sessionId,
      artifactId: message.artifactId,
      contentVersionId: message.contentVersionId,
      attemptId: message.attemptId,
      runId: message.runId,
      sequence: 1,
      baseStateRevision: message.stateRevision,
      kind: 'ready',
      payload: { digest: message.contentDigest }
    }), '*');
    if (message.sdk) {
      const sdk = document.createElement('script');
      sdk.textContent = message.sdk;
      document.head.appendChild(sdk);
    }
    const activity = document.createElement('script');
    activity.textContent = message.javascript;
    document.body.appendChild(activity);
  };
  window.addEventListener('message', onHostMessage, true);
})();`;

export const createActivityRelayScript = () => `(() => {
  const frame = document.getElementById('scholar-activity-frame');
  const pendingHostMessages = [];
  let frameReady = false;
  const maximumHostBytes = 700000;
  const maximumActivityBytes = ${96 * 1024};
  const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
  const sendToFrame = (message) => {
    if (!frame?.contentWindow) return false;
    frame.contentWindow.postMessage(message, '*');
    return true;
  };
  window.addEventListener('message', (event) => {
    if (event.source === window && typeof event.data === 'string' && utf8Bytes(event.data) <= maximumHostBytes) {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.source !== 'scholar-host') return;
      if (!frameReady) {
        if (pendingHostMessages.length >= 1) {
          window.postMessage('!ACTIVITY_MESSAGE_OVERFLOW!', '*');
          return;
        }
        pendingHostMessages.push(event.data);
        return;
      }
      sendToFrame(event.data);
      return;
    }

    if (event.source !== frame?.contentWindow || event.origin !== 'null' || typeof event.data !== 'string') return;
    if (utf8Bytes(event.data) > maximumActivityBytes) {
      window.postMessage('!ACTIVITY_MESSAGE_OVERFLOW!', '*');
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch {
      window.postMessage(event.data, '*');
      return;
    }
    if (message.source === 'scholar-activity-frame' && message.kind === 'frame-ready') {
      frameReady = true;
      for (const pendingMessage of pendingHostMessages.splice(0)) sendToFrame(pendingMessage);
      return;
    }
    if (message.source === 'activity') window.postMessage(event.data, '*');
  }, true);
})();`;

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('base64');

const isRasterImageDataUrl = (value: string) =>
  /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);/i.test(value);

const sanitizeActivityMarkup = (html: string) => {
  const fragment = parseFragment(html);
  const visit = (node: ActivityMarkupNode) => {
    if (node.childNodes) {
      node.childNodes = node.childNodes.filter((child) => {
        const tagName = child.tagName?.toLowerCase();
        if (tagName && deniedMarkupTags.has(tagName)) return false;

        if (child.attrs) {
          child.attrs = child.attrs.filter((attribute) => {
            const name = attribute.name.toLowerCase();
            if (name.startsWith('on') || name === 'formaction') return false;
            if (name === 'srcset') return false;
            if (
              name === 'src' &&
              tagName === 'img' &&
              !isRasterImageDataUrl(attribute.value)
            )
              return false;
            if (
              (name === 'href' || name === 'xlink:href') &&
              tagName === 'image' &&
              !isRasterImageDataUrl(attribute.value)
            )
              return false;
            if (
              (name === 'href' || name === 'xlink:href') &&
              tagName === 'use' &&
              !attribute.value.startsWith('#')
            )
              return false;
            return true;
          });
        }

        visit(child);
        return true;
      });
    }
    if (node.content) visit(node.content);
  };

  visit(fragment as unknown as ActivityMarkupNode);
  return serialize(fragment);
};

const serializeActivityBundle = (bundle: ActivityBundle) =>
  JSON.stringify({
    html: bundle.html,
    css: bundle.css,
    sdk: bundle.sdk,
    javascript: bundle.javascript,
  });

export const createActivityContentDigest = (bundle: ActivityBundle) =>
  createHash('sha256')
    .update(serializeActivityBundle(bundle), 'utf8')
    .digest('hex');

export const buildActivityDocument = (
  bundle: ActivityBundle,
  nonce = 'test-only',
  parentOrigin = 'scholar-activity://fixture',
): ActivityDocument => {
  const bundleBytes = Buffer.byteLength(
    serializeActivityBundle(bundle),
    'utf8',
  );
  if (bundleBytes > maximumBundleBytes)
    throw new Error('Activity content exceeds the accepted 512 KiB limit.');

  const bootstrapScript = createActivityBootstrapScript(nonce, parentOrigin);
  const relayScript = createActivityRelayScript();
  const safeMarkup = sanitizeActivityMarkup(bundle.html);
  const scriptHashes = [
    `'sha256-${sha256(relayScript)}'`,
    `'sha256-${sha256(bootstrapScript)}'`,
    ...(bundle.sdk ? [`'sha256-${sha256(bundle.sdk)}'`] : []),
    ...(bundle.javascript ? [`'sha256-${sha256(bundle.javascript)}'`] : []),
  ];
  const commonDirectives = [
    "default-src 'none'",
    `script-src ${scriptHashes.join(' ')}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    "font-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const innerPolicy = [...commonDirectives, "frame-src 'none'"].join('; ');
  const outerPolicy = [
    ...commonDirectives,
    'sandbox allow-scripts',
    "frame-src 'self' about:",
    "frame-ancestors 'none'",
  ].join('; ');
  const innerDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(innerPolicy)}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="activity-root">${safeMarkup}</main><script>${bootstrapScript}</script></body></html>`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><iframe id="scholar-activity-frame" title="Learning activity" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttribute(innerDocument)}"></iframe><script>${relayScript}</script></body></html>`;
  if (Buffer.byteLength(body, 'utf8') > maximumDocumentBytes)
    throw new Error('Activity document exceeds the 2 MiB runtime limit.');

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': outerPolicy,
    'Connection-Allowlist': activityConnectionAllowlistHeader,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), clipboard-read=(), usb=(), serial=(), bluetooth=()',
  };

  return { body, bootstrapScript, relayScript, headers };
};
