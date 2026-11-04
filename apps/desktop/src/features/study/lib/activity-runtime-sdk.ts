import { createHash } from 'node:crypto';
import { activityRuntimeVersion } from '@scholaros/services/learning/activity-contracts';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';

export type ActivityRuntimeState = {
  version: 1;
  inputs: Record<string, JsonValue>;
  rngSeed: number | string;
  canvas: Record<string, JsonValue>;
  progress: Record<string, JsonValue>;
};

export type ActivityRuntimeTheme = {
  background?: string;
  foreground?: string;
  muted?: string;
  mutedForeground?: string;
  primary?: string;
  accent?: string;
  border?: string;
};

export type ActivityRuntimeSdkApi = {
  readonly version: 1;
  readonly runtimeVersion: 'activity-runtime-v1';
  readonly acknowledgedRevision: number | null;
  readonly theme: Readonly<ActivityRuntimeTheme>;
  getState: () => JsonValue | null;
  onRestore: (
    listener: (
      state: JsonValue,
      revision: number,
      theme: Readonly<ActivityRuntimeTheme>,
    ) => void,
  ) => () => void;
  proposeState: (state: JsonValue) => void;
  interaction: (action: string, value?: JsonValue) => void;
  reportError: (code: string) => void;
  requestReset: () => void;
  random: (seed: number, index?: number) => number;
  controls: {
    range: (input: {
      root: HTMLElement;
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      value: number;
      onInput?: (value: number) => void;
    }) => {
      input: HTMLInputElement;
      output: HTMLOutputElement;
      value: () => number;
    };
    answerInput: (input: {
      root: HTMLElement;
      id: string;
      label: string;
      expectedAnswer: string;
      correctMessage: string;
      incorrectMessage: string;
    }) => {
      form: HTMLFormElement;
      value: HTMLInputElement;
      submit: HTMLButtonElement;
      feedback: HTMLOutputElement;
    };
  };
  graph: {
    renderSvg: (input: {
      svg: SVGSVGElement;
      points: { x: number; y: number }[];
      label: string;
      width?: number;
      height?: number;
    }) => SVGPolylineElement;
    renderCanvas: (input: {
      canvas: HTMLCanvasElement;
      points: { x: number; y: number }[];
      label: string;
      width?: number;
      height?: number;
    }) => boolean;
  };
};

export const activityRuntimeSdkSource = String.raw`(() => {
  'use strict';

  const runtimeVersion = 'activity-runtime-v1';
  const messageLimit = 16 * 1024;
  const stateLimit = 64 * 1024;
  const stateEnvelopeLimit = 96 * 1024;
  const themeKeys = ['background', 'foreground', 'muted', 'mutedForeground', 'primary', 'accent', 'border'];
  const utf8Length = (value) => new TextEncoder().encode(value).byteLength;
  const isPlainObject = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const isJsonValue = (value, depth = 0) => {
    if (depth > 12) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
    if (!isPlainObject(value)) return false;
    return Object.entries(value).every(([key, item]) =>
      key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && isJsonValue(item, depth + 1)
    );
  };
  const cloneJson = (value) => JSON.parse(JSON.stringify(value));
  const assertJson = (value, maximumBytes) => {
    if (!isJsonValue(value)) throw new TypeError('Activity state must be bounded JSON data.');
    const json = JSON.stringify(value);
    if (utf8Length(json) > maximumBytes) throw new RangeError('Activity state exceeds its byte limit.');
    return json;
  };
  const safeColor = (value) => {
    if (typeof value !== 'string' || value.length > 100 || /url\s*\(|var\s*\(/i.test(value)) return false;
    const probe = document.createElement('span');
    probe.style.color = '';
    probe.style.color = value;
    return probe.style.color !== '';
  };
  const safeTheme = (value) => {
    if (!isPlainObject(value)) return Object.freeze({});
    const theme = {};
    for (const key of themeKeys) {
      if (safeColor(value[key])) theme[key] = value[key];
    }
    return Object.freeze(theme);
  };
  const detailEvent = (name, detail) => {
    window.dispatchEvent(new CustomEvent('scholar-activity:' + name, { detail }));
  };
  const numeric = (value, label) => {
    if (!Number.isFinite(value)) throw new TypeError(label + ' must be finite.');
    return value;
  };
  const boundedLabel = (value, label) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 300) {
      throw new TypeError(label + ' must be a nonempty label.');
    }
    return value;
  };
  const pointList = (points) => {
    if (!Array.isArray(points) || points.length < 2 || points.length > 512) {
      throw new RangeError('A graph needs between 2 and 512 points.');
    }
    return points.map((point) => ({ x: numeric(point.x, 'x'), y: numeric(point.y, 'y') }));
  };
  const extent = (values) => {
    let minimum = Math.min.apply(null, values);
    let maximum = Math.max.apply(null, values);
    if (maximum === minimum) {
      minimum -= 1;
      maximum += 1;
    }
    return { minimum, maximum };
  };
  const scaledPoints = (points, width, height, padding) => {
    const xExtent = extent(points.map((point) => point.x));
    const yExtent = extent(points.map((point) => point.y));
    return points.map((point) => ({
      x: padding + ((point.x - xExtent.minimum) / (xExtent.maximum - xExtent.minimum)) * (width - padding * 2),
      y: height - padding - ((point.y - yExtent.minimum) / (yExtent.maximum - yExtent.minimum)) * (height - padding * 2),
    }));
  };

  let identity = null;
  let revision = null;
  let outgoingSequence = 0;
  let incomingSequence = 0;
  let contentDigest = null;
  let hostTheme = Object.freeze({});
  let latestState;
  let pendingState;
  let checkpointAwaitingResult = false;
  let restored = false;
  const restoreListeners = new Set();
  const identityKeys = ['sessionId', 'artifactId', 'contentVersionId', 'attemptId', 'runId'];
  const commonHostEnvelopeKeys = [
    'protocolVersion', 'runtimeVersion', 'source', 'sessionId', 'artifactId',
    'contentVersionId', 'attemptId', 'runId', 'sequence', 'kind',
  ];
  const restoreHostEnvelopeKeys = [
    ...commonHostEnvelopeKeys, 'stateRevision', 'contentDigest', 'state', 'theme',
  ];
  const checkpointHostEnvelopeKeys = [...commonHostEnvelopeKeys, 'stateRevision'];
  const hasExactKeys = (value, keys) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const matchesIdentity = (message) =>
    identity !== null && identityKeys.every((key) => message[key] === identity[key]);

  const emit = (kind, payload) => {
    if (!identity || revision === null) throw new Error('Activity host is not ready.');
    const sequence = outgoingSequence + 1;
    const message = {
      protocolVersion: 1,
      runtimeVersion,
      source: 'activity',
      ...identity,
      sequence,
      baseStateRevision: revision,
      kind,
      payload,
    };
    const serialized = JSON.stringify(message);
    const limit = kind === 'state-proposed' ? stateEnvelopeLimit : messageLimit;
    if (utf8Length(serialized) > limit) throw new RangeError('Activity message exceeds its byte limit.');
    outgoingSequence = sequence;
    window.postMessage(serialized, '*');
  };
  const flushPendingState = () => {
    if (checkpointAwaitingResult || pendingState === undefined) return;
    const state = pendingState;
    pendingState = undefined;
    const serialized = assertJson(state, stateLimit);
    emit('state-proposed', { state: JSON.parse(serialized) });
    checkpointAwaitingResult = true;
    latestState = JSON.parse(serialized);
  };
  const handleHostMessage = (event) => {
    if (event.source !== window || event.origin !== 'null' || typeof event.data !== 'string') return;
    if (utf8Length(event.data) > stateEnvelopeLimit) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isPlainObject(message) || message.source !== 'scholar-host' || message.protocolVersion !== 1 || message.runtimeVersion !== runtimeVersion) return;
    if (!Number.isSafeInteger(message.sequence)) return;
    const hostKinds = ['restore', 'state-acknowledged', 'state-rejected'];
    if (!hostKinds.includes(message.kind)) return;
    if (message.kind === 'restore') {
      if (restored || message.sequence !== 1 || !hasExactKeys(message, restoreHostEnvelopeKeys)) return;
      if (identityKeys.some((key) => typeof message[key] !== 'string' || message[key].length === 0 || message[key].length > 300)) return;
      if (!Number.isSafeInteger(message.stateRevision) || message.stateRevision < 0 || typeof message.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(message.contentDigest) || !isPlainObject(message.theme)) return;
      try {
        assertJson(message.state, stateLimit);
      } catch {
        return;
      }
      identity = {
        sessionId: message.sessionId,
        artifactId: message.artifactId,
        contentVersionId: message.contentVersionId,
        attemptId: message.attemptId,
        runId: message.runId,
      };
      restored = true;
      incomingSequence = message.sequence;
      outgoingSequence = 0;
      revision = message.stateRevision;
      contentDigest = message.contentDigest;
      hostTheme = safeTheme(message.theme);
      latestState = cloneJson(message.state);
      pendingState = undefined;
      checkpointAwaitingResult = false;
      emit('ready', { contentDigest });
      const restoredState = Object.freeze({ state: cloneJson(latestState), stateRevision: revision, theme: hostTheme });
      for (const listener of restoreListeners) listener(restoredState.state, restoredState.stateRevision, restoredState.theme);
      detailEvent('restore', restoredState);
      return;
    }
    if (!restored || !identity || revision === null || !hasExactKeys(message, checkpointHostEnvelopeKeys) || !matchesIdentity(message) || message.sequence !== incomingSequence + 1) return;
    if (message.kind === 'state-acknowledged') {
      if (!checkpointAwaitingResult || !Number.isSafeInteger(message.stateRevision) || message.stateRevision !== revision + 1) return;
      incomingSequence = message.sequence;
      revision = message.stateRevision;
      checkpointAwaitingResult = false;
      detailEvent('state-acknowledged', { stateRevision: revision, state: cloneJson(latestState) });
      flushPendingState();
      return;
    }
    if (!checkpointAwaitingResult || !Number.isSafeInteger(message.stateRevision) || message.stateRevision !== revision) return;
    incomingSequence = message.sequence;
    detailEvent('state-rejected', { stateRevision: revision });
  };
  window.addEventListener('message', handleHostMessage, true);

  const controls = {
    range: ({ root, id, label, min, max, step = 1, value, onInput }) => {
      if (!(root instanceof Element)) throw new TypeError('A control root is required.');
      boundedLabel(label, 'Control label');
      if (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new TypeError('Control id is invalid.');
      numeric(min, 'Minimum');
      numeric(max, 'Maximum');
      numeric(step, 'Step');
      numeric(value, 'Value');
      if (min >= max || step <= 0) throw new RangeError('Control bounds are invalid.');
      const wrapper = document.createElement('label');
      wrapper.append(document.createTextNode(label));
      const input = document.createElement('input');
      input.id = id;
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(Math.min(max, Math.max(min, value)));
      const output = document.createElement('output');
      output.htmlFor = id;
      output.textContent = input.value;
      input.addEventListener('input', () => {
        output.value = input.value;
        output.textContent = input.value;
        if (typeof onInput === 'function') onInput(Number(input.value));
      });
      wrapper.append(input);
      root.append(wrapper, output);
      return Object.freeze({ input, output, value: () => Number(input.value) });
    },
    answerInput: ({ root, id, label, expectedAnswer, correctMessage, incorrectMessage }) => {
      if (!(root instanceof Element)) throw new TypeError('A control root is required.');
      boundedLabel(label, 'Answer label');
      boundedLabel(correctMessage, 'Correct feedback');
      boundedLabel(incorrectMessage, 'Try-again feedback');
      if (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(id) || typeof expectedAnswer !== 'string') {
        throw new TypeError('Answer input is invalid.');
      }
      const form = document.createElement('form');
      const fieldLabel = document.createElement('label');
      fieldLabel.htmlFor = id;
      fieldLabel.textContent = label;
      const value = document.createElement('input');
      value.id = id;
      value.name = id;
      value.type = 'text';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Check answer';
      const feedback = document.createElement('output');
      feedback.setAttribute('role', 'status');
      form.append(fieldLabel, value, submit, feedback);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const correct = value.value.trim().toLocaleLowerCase() === expectedAnswer.trim().toLocaleLowerCase();
        feedback.textContent = correct ? correctMessage : incorrectMessage;
      });
      root.append(form);
      return Object.freeze({ form, value, submit, feedback });
    },
  };

  const graph = {
    renderSvg: ({ svg, points, label, width = 640, height = 360 }) => {
      if (!(svg instanceof SVGElement)) throw new TypeError('An SVG element is required.');
      boundedLabel(label, 'Graph alternative');
      numeric(width, 'Graph width');
      numeric(height, 'Graph height');
      if (width < 40 || height < 40 || width > 2000 || height > 2000) throw new RangeError('Graph dimensions are invalid.');
      const validPoints = pointList(points);
      const rendered = scaledPoints(validPoints, width, height, 20);
      svg.replaceChildren();
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = label;
      const description = document.createElementNS('http://www.w3.org/2000/svg', 'desc');
      description.textContent = label;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('points', rendered.map((point) => point.x + ',' + point.y).join(' '));
      svg.append(title, description, line);
      return line;
    },
    renderCanvas: ({ canvas, points, label, width = 640, height = 360 }) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('A Canvas2D element is required.');
      boundedLabel(label, 'Canvas alternative');
      numeric(width, 'Canvas width');
      numeric(height, 'Canvas height');
      if (width < 40 || height < 40 || width > 2000 || height > 2000) throw new RangeError('Canvas dimensions are invalid.');
      const validPoints = pointList(points);
      const rendered = scaledPoints(validPoints, width, height, 20);
      canvas.width = width;
      canvas.height = height;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', label);
      let alternative = canvas.nextElementSibling;
      if (!alternative || alternative.getAttribute('data-activity-text-alternative') !== 'true') {
        alternative = document.createElement('p');
        alternative.setAttribute('data-activity-text-alternative', 'true');
        canvas.after(alternative);
      }
      alternative.textContent = label;
      const context = canvas.getContext('2d');
      if (!context) return false;
      context.clearRect(0, 0, width, height);
      context.beginPath();
      context.moveTo(rendered[0].x, rendered[0].y);
      for (const point of rendered.slice(1)) context.lineTo(point.x, point.y);
      context.strokeStyle = hostTheme.foreground || 'CanvasText';
      context.lineWidth = 2;
      context.stroke();
      return true;
    },
  };

  const seededRandom = (seed, index = 0) => {
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(index) || index < 0) throw new TypeError('A stable random seed and index are required.');
    let value = (seed + Math.imul(index + 1, 0x6D2B79F5)) | 0;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  const api = {
    version: 1,
    runtimeVersion,
    controls: Object.freeze(controls),
    graph: Object.freeze(graph),
    get acknowledgedRevision() {
      return revision;
    },
    get theme() {
      return hostTheme;
    },
    getState: () => latestState === undefined ? null : cloneJson(latestState),
    onRestore: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('Restore listener must be a function.');
      restoreListeners.add(listener);
      if (revision !== null && latestState !== undefined) {
        listener(cloneJson(latestState), revision, hostTheme);
      }
      return () => {
        restoreListeners.delete(listener);
      };
    },
    proposeState: (state) => {
      const serialized = assertJson(state, stateLimit);
      const candidate = JSON.parse(serialized);
      if (checkpointAwaitingResult) pendingState = candidate;
      else {
        pendingState = candidate;
        flushPendingState();
      }
    },
    interaction: (action, value = null) => {
      if (typeof action !== 'string' || action.length === 0 || action.length > 100) throw new TypeError('Activity action is invalid.');
      if (!isJsonValue(value)) throw new TypeError('Activity interaction value must be JSON data.');
      emit('interaction', { action, value });
    },
    reportError: (code) => {
      if (typeof code !== 'string' || !/^[a-z0-9-]{1,100}$/.test(code)) throw new TypeError('Activity error code is invalid.');
      emit('runtime-error', { code });
    },
    requestReset: () => api.interaction('request-reset', null),
    random: seededRandom,
  };
  Object.defineProperty(window, 'ScholarActivity', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(api),
  });
})();`;

export const activityRuntimeSdkVersion = activityRuntimeVersion;
export const activityRuntimeSdkDigest = createHash('sha256')
  .update(activityRuntimeSdkSource, 'utf8')
  .digest('hex');
