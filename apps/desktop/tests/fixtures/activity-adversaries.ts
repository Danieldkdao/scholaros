export type ActivityAdversaryTargets = {
  httpUrl: string;
  webSocketUrl: string;
  stunUrl: string;
  turnTcpUrl: string;
  fileUrl: string;
  authSchemeUrl: string;
};

export type ActivityAdversaryBinding = {
  sessionId: string;
  artifactId: string;
  contentVersionId: string;
  attemptId: string;
  runId: string;
};

export const createActivityAdversaryScript = (
  targets: ActivityAdversaryTargets,
  binding: ActivityAdversaryBinding,
  stressAfterProposal = false,
) => `(() => {
  const targets = ${JSON.stringify(targets)};
  const binding = ${JSON.stringify(binding)};
  const stressAfterProposal = ${JSON.stringify(stressAfterProposal)};
  const result = {
    origin: location.origin,
    protocol: location.protocol,
    restoredState: window.__scholarActivityInitialState,
    cookie: '',
    localStorage: 'unavailable',
    requireType: typeof require,
    processType: typeof process,
    bufferType: typeof Buffer,
    moduleType: typeof module,
    scholarType: typeof window.scholar,
    authTypes: ['getUser', 'requestAuth', 'signOut', 'authenticate'].map((name) => typeof window[name]),
    openerIsNull: window.opener === null,
    parentIsSelf: window.parent === window,
    parentDomBlocked: false,
    frameCount: window.frames.length,
    evalBlocked: false,
    fetchBlocked: false,
    websocketBlocked: false,
    imageBlocked: false,
    fileBlocked: false,
    authSchemeBlocked: false,
    filePickerHadNoFiles: false,
    fileSystemApiBlocked: false,
    pasteSawNoFiles: false,
    dropSawNoFiles: false,
    workerBlocked: false,
    popupWasDenied: false,
    permissionQueryDenied: false,
    webrtcState: 'not-started',
    attackError: null,
  };
  const setPhase = (phase) => {
    document.documentElement.dataset.activityPhase = phase;
  };

  setPhase('started');
  try { result.cookie = document.cookie; } catch { result.cookie = 'unavailable'; }
  try { result.localStorage = String(localStorage.length); } catch { result.localStorage = 'unavailable'; }
  try { void window.parent.document.title; } catch { result.parentDomBlocked = true; }
  try { eval('1 + 1'); } catch { result.evalBlocked = true; }

  let stateRevision = Number(window.__scholarActivityStateRevision ?? 0);
  let nextSequence = 2;
  const ackResolvers = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || typeof event.data !== 'string') return;
    try {
      const acknowledgement = JSON.parse(event.data);
      if (acknowledgement.kind !== 'state-ack') return;
      stateRevision = acknowledgement.revision;
      ackResolvers.get(acknowledgement.sequence)?.();
      ackResolvers.delete(acknowledgement.sequence);
    } catch {}
  });

  const sendProposal = (state) => new Promise((resolve) => {
    const sequence = nextSequence++;
    ackResolvers.set(sequence, resolve);
    window.parent.postMessage(JSON.stringify({
      protocolVersion: 1,
      runtimeVersion: 'activity-runtime-v1',
      source: 'activity',
      ...binding,
      sequence,
      baseStateRevision: stateRevision,
      kind: 'state-proposed',
      payload: { state },
    }), '*');
  });

  const settle = (promise, timeout = 1200) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
  const deniedFetch = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      return !response.ok;
    } catch {
      return true;
    }
  };

  const attack = async () => {
    setPhase('http-probes');
    result.fetchBlocked = await deniedFetch(targets.httpUrl);
    result.fileBlocked = await deniedFetch(targets.fileUrl);
    result.authSchemeBlocked = await deniedFetch(targets.authSchemeUrl);

    result.websocketBlocked = await new Promise((resolve) => {
      const socket = new WebSocket(targets.webSocketUrl);
      const timeout = setTimeout(() => {
        socket.close();
        resolve(true);
      }, 1200);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        socket.close();
        resolve(false);
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(true);
      }, { once: true });
    });

    result.imageBlocked = await new Promise((resolve) => {
      const image = new Image();
      const timeout = setTimeout(() => resolve(true), 1200);
      image.addEventListener('load', () => {
        clearTimeout(timeout);
        resolve(false);
      }, { once: true });
      image.addEventListener('error', () => {
        clearTimeout(timeout);
        resolve(true);
      }, { once: true });
      image.src = targets.httpUrl;
    });

    setPhase('worker-probe');
    result.workerBlocked = await new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker('data:text/javascript,postMessage(1)');
      } catch {
        resolve(true);
        return;
      }
      const timeout = setTimeout(() => {
        worker.terminate();
        resolve(true);
      }, 1200);
      worker.addEventListener('message', () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(false);
      }, { once: true });
      worker.addEventListener('error', () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(true);
      }, { once: true });
    });

    try {
      const permission = await navigator.permissions.query({ name: 'camera' });
      result.permissionQueryDenied = permission.state === 'denied';
    } catch {
      result.permissionQueryDenied = true;
    }

    setPhase('file-picker-probe');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.addEventListener('change', () => {
      result.filePickerHadNoFiles = fileInput.files?.length === 0;
    });
    fileInput.click();
    result.filePickerHadNoFiles ||= fileInput.files?.length === 0;

    setPhase('file-system-probe');
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        await window.showOpenFilePicker();
        result.fileSystemApiBlocked = false;
      } else {
        result.fileSystemApiBlocked = true;
      }
    } catch {
      result.fileSystemApiBlocked = true;
    }

    setPhase('paste-drop-probe');
    let pasteFilesSeen = false;
    let dropFilesSeen = false;
    document.addEventListener('paste', (event) => {
      pasteFilesSeen = Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === 'file');
    });
    document.addEventListener('drop', (event) => {
      dropFilesSeen = Array.from(event.dataTransfer?.files ?? []).length > 0;
    });
    const file = new File(['fixture-only'], 'fixture.txt', { type: 'text/plain' });
    const pasteData = new DataTransfer();
    pasteData.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteData, bubbles: true, cancelable: true }));
    const dropData = new DataTransfer();
    dropData.items.add(file);
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dropData, bubbles: true, cancelable: true }));
    result.pasteSawNoFiles = !pasteFilesSeen;
    result.dropSawNoFiles = !dropFilesSeen;

    setPhase('no-cors-probe');
    try {
      const response = await fetch(targets.httpUrl, { mode: 'no-cors' });
      result.fetchBlocked &&= response.type === 'opaque' || response.status === 0;
    } catch {
      result.fetchBlocked = true;
    }

    setPhase('popup-probe');
    try {
      result.popupWasDenied = window.open(targets.httpUrl) === null;
    } catch {
      result.popupWasDenied = true;
    }

    setPhase('state-proposal');
    await sendProposal(result);
    if (!stressAfterProposal) return;

    await new Promise((resolve) => setTimeout(resolve, 3000));
    result.webrtcState = 'attempted';
    await sendProposal(result);
    try {
      const peer = new RTCPeerConnection({
        iceServers: [
          { urls: targets.stunUrl },
          { urls: targets.turnTcpUrl, username: 'fixture', credential: 'fixture' },
        ],
      });
      peer.createDataChannel('fixture');
      await peer.setLocalDescription(await peer.createOffer());
      await settle(new Promise((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') resolve(true);
        });
      }), 1600);
      peer.close();
    } catch {
      result.webrtcState = 'blocked';
    }

    const stopAt = Date.now() + 20000;
    while (Date.now() < stopAt) {}
  };

  void attack().catch((error) => {
    result.attackError = error instanceof Error ? error.name : 'unknown';
    void sendProposal(result);
  });
})();`;
