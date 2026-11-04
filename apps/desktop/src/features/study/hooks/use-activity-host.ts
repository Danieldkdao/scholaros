import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RefCallback } from 'react';
import type {
  ArtifactStateDTO,
  ArtifactVersionDTO,
} from '@scholaros/services/learning/activity-contracts';
import type { ContextItemDTO } from '@scholaros/services/learning/context-contracts';
import type { SafeErrorCode } from '@scholaros/services/learning/product-contracts';
import type { ActivityPresentation } from '@scholaros/services/learning/activity-contracts';
import type { ActivityBounds } from '../lib/activity-geometry';
import {
  getActivityBounds,
  getActivityClippingAncestors,
  getActivityScrollAnchor,
  getActivityViewport,
  isActivityOccluded,
  restoreActivityScrollAnchor,
} from '../lib/activity-geometry';

export type ActivityRuntimeChange = {
  runId: string;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
} & (
  | {
      kind: 'ready';
      stateRevision: number;
      runtimeVersion: string;
      contentDigest: string;
    }
  | { kind: 'checkpoint-pending'; stateRevision: number }
  | { kind: 'checkpoint-acknowledged'; stateRevision: number }
  | {
      kind: 'checkpoint-failed';
      stateRevision: number;
      errorCode: SafeErrorCode;
    }
  | { kind: 'runtime-error' | 'closed'; errorCode: SafeErrorCode }
);

export type ActivityHostBridge = {
  getArtifactVersion: (input: {
    artifactId: string;
    versionId: string;
  }) => Promise<ArtifactVersionDTO | null>;
  getArtifactState: (input: {
    artifactId: string;
    versionId: string;
    attemptId: string;
  }) => Promise<ArtifactStateDTO | null>;
  mountActivity: (input: {
    sessionId: string;
    artifactId: string;
    versionId: string;
    attemptId: string;
    presentation: ActivityPresentation;
    readOnly: boolean;
    bounds: ActivityBounds;
  }) => Promise<{ runId: string }>;
  updateActivityBounds: (input: {
    runId: string;
    bounds: ActivityBounds;
    visible: boolean;
  }) => Promise<void>;
  closeActivity: (input: { runId: string }) => Promise<void>;
  onActivityChange: (
    runId: string,
    listener: (change: ActivityRuntimeChange) => void,
  ) => () => void;
  retryActivityCheckpoint: (input: { runId: string }) => Promise<void>;
  resetArtifactAttempt: (input: {
    artifactId: string;
    versionId: string;
    attemptId: string;
    requestId: string;
  }) => Promise<ArtifactStateDTO>;
  saveArtifactToContext: (input: {
    artifactId: string;
    versionId: string;
    courseId?: string | null;
    requestId: string;
  }) => Promise<ContextItemDTO>;
};

export type ActivityHostStatus =
  | 'loading'
  | 'starting'
  | 'ready'
  | 'checkpoint-pending'
  | 'checkpoint-error'
  | 'runtime-error'
  | 'unavailable'
  | 'unsupported';

export type ActivityHostStatusPresentation = {
  label: string;
  icon: 'loading' | 'ready' | 'pending' | 'error' | 'info';
};

type UseActivityHostOptions = {
  accountId: string;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  presentation: ActivityPresentation;
  readOnly: boolean;
  bridge?: ActivityHostBridge;
};

const createRequestId = () => crypto.randomUUID();

const getDefaultActivityHostBridge = (): ActivityHostBridge =>
  window.scholar as unknown as ActivityHostBridge;

export const formatActivityHostStatus = (
  status: ActivityHostStatus,
): ActivityHostStatusPresentation => {
  switch (status) {
    case 'loading':
      return { label: 'Loading activity', icon: 'loading' };
    case 'starting':
      return { label: 'Starting activity', icon: 'loading' };
    case 'ready':
      return { label: 'Ready to explore', icon: 'ready' };
    case 'checkpoint-pending':
      return { label: 'Saving activity progress', icon: 'pending' };
    case 'checkpoint-error':
      return { label: 'Progress could not be saved', icon: 'error' };
    case 'runtime-error':
      return { label: 'Activity stopped', icon: 'error' };
    case 'unavailable':
      return { label: 'Activity unavailable', icon: 'info' };
    case 'unsupported':
      return { label: 'Activity version unsupported', icon: 'info' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const formatActivityRuntimeError = (code: SafeErrorCode): string => {
  switch (code) {
    case 'offline':
      return 'Activity progress is saved locally when storage is available.';
    case 'storage-failed':
      return 'Your last saved progress is still available; this change is not saved yet.';
    case 'unsupported':
      return 'This activity version cannot run in this app version.';
    case 'limit-exceeded':
      return 'The activity was stopped after exceeding its safe limits.';
    case 'feature-unavailable':
      return 'The activity runtime is not available yet.';
    case 'invalid-input':
    case 'not-found':
    case 'scope-denied':
    case 'session-changed':
    case 'permission-revoked':
    case 'busy':
    case 'revision-conflict':
    case 'cancelled':
    case 'needs-sign-in':
    case 'rate-limited':
    case 'capability-changed':
    case 'unreadable':
    case 'provider-failed':
      return 'Your last saved progress is still available; reopen the activity to try again.';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
};

export const useActivityHost = ({
  accountId,
  sessionId,
  artifactId,
  versionId,
  attemptId: initialAttemptId,
  presentation,
  readOnly,
  bridge: bridgeOverride,
}: UseActivityHostOptions) => {
  const bridge = bridgeOverride ?? getDefaultActivityHostBridge();
  const resourceKey = JSON.stringify([
    accountId,
    sessionId,
    artifactId,
    versionId,
    initialAttemptId,
  ]);
  const [version, setVersion] = useState<ArtifactVersionDTO | null>(null);
  const [savedState, setSavedState] = useState<ArtifactStateDTO | null>(null);
  const [attemptId, setAttemptId] = useState(initialAttemptId);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<ActivityHostStatus>('loading');
  const [errorCode, setErrorCode] = useState<SafeErrorCode | null>(null);
  const [geometry, setGeometry] = useState<{
    bounds: ActivityBounds | null;
    occluded: boolean;
  }>({ bounds: null, occluded: false });
  const [retryNonce, setRetryNonce] = useState(0);
  const slotElementRef = useRef<HTMLDivElement | null>(null);
  const [slotElement, setSlotElement] = useState<HTMLDivElement | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastBoundsRef = useRef<ActivityBounds | null>(null);
  const lastBoundsRequestRef = useRef<string | null>(null);
  const closeBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const closeCurrentRunRef = useRef<() => Promise<void>>(() =>
    Promise.resolve(),
  );
  const presentationRef = useRef(presentation);
  const geometryRef = useRef(geometry);
  const [lastAcknowledgedRevision, setLastAcknowledgedRevision] = useState(0);

  presentationRef.current = presentation;
  geometryRef.current = geometry;

  const slotRef: RefCallback<HTMLDivElement> = useCallback((element) => {
    slotElementRef.current = element;
    setSlotElement(element);
  }, []);

  const receiveRuntimeChange = useCallback(
    (change: ActivityRuntimeChange) => {
      if (
        change.runId !== runIdRef.current ||
        change.sessionId !== sessionId ||
        change.artifactId !== artifactId ||
        change.versionId !== versionId ||
        change.attemptId !== attemptId
      ) {
        return;
      }
      switch (change.kind) {
        case 'ready':
          if (
            change.runtimeVersion !== 'activity-runtime-v1' ||
            change.contentDigest !== version?.contentDigest
          ) {
            setStatus('runtime-error');
            setErrorCode('unsupported');
            void closeCurrentRunRef.current();
            return;
          }
          setLastAcknowledgedRevision(change.stateRevision);
          setStatus('ready');
          setErrorCode(null);
          return;
        case 'checkpoint-pending':
          setStatus('checkpoint-pending');
          setErrorCode(null);
          return;
        case 'checkpoint-acknowledged':
          setLastAcknowledgedRevision(change.stateRevision);
          setStatus('ready');
          setErrorCode(null);
          return;
        case 'checkpoint-failed':
          setStatus('checkpoint-error');
          setErrorCode(change.errorCode);
          return;
        case 'runtime-error':
        case 'closed':
          setStatus('runtime-error');
          setErrorCode(change.errorCode);
          void closeCurrentRunRef.current();
          return;
        default: {
          const exhaustive: never = change;
          return exhaustive;
        }
      }
    },
    [artifactId, attemptId, sessionId, version, versionId],
  );

  const closeCurrentRun = useCallback((): Promise<void> => {
    const activeRunId = runIdRef.current;
    if (!activeRunId) return closeBarrierRef.current;
    runIdRef.current = null;
    setRunId(null);
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const bounds = lastBoundsRef.current;
    const closeOperation = closeBarrierRef.current
      .then(async () => {
        if (bounds) {
          await bridge
            .updateActivityBounds({
              runId: activeRunId,
              bounds,
              visible: false,
            })
            .catch(() => undefined);
        }
        await bridge.closeActivity({ runId: activeRunId });
      })
      .catch(() => undefined);
    closeBarrierRef.current = closeOperation;
    return closeOperation;
  }, [bridge]);
  closeCurrentRunRef.current = closeCurrentRun;

  useEffect(() => {
    let current = true;
    setVersion(null);
    setSavedState(null);
    setStatus('loading');
    setErrorCode(null);
    setAttemptId(initialAttemptId);
    setLastAcknowledgedRevision(0);

    void Promise.resolve()
      .then(() => bridge.getArtifactVersion({ artifactId, versionId }))
      .then(async (artifactVersion) => {
        if (!current) return;
        if (!artifactVersion) {
          setStatus('unavailable');
          return;
        }
        setVersion(artifactVersion);
        if (!artifactVersion.available) {
          setStatus('unavailable');
          return;
        }
        if (artifactVersion.runtimeVersion !== 1) {
          setStatus('unsupported');
          setErrorCode('unsupported');
          return;
        }
        const artifactState = await bridge.getArtifactState({
          artifactId,
          versionId,
          attemptId: initialAttemptId,
        });
        if (!current) return;
        if (!artifactState || artifactState.attemptId !== initialAttemptId) {
          setStatus('unavailable');
          return;
        }
        setSavedState(artifactState);
        setLastAcknowledgedRevision(artifactState?.stateRevision ?? 0);
        setStatus('starting');
      })
      .catch(() => {
        if (current) setStatus('unavailable');
      });
    return () => {
      current = false;
    };
  }, [artifactId, bridge, initialAttemptId, resourceKey, versionId]);

  useLayoutEffect(() => {
    const element = slotElement;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      timer = null;
      const clippingAncestors = getActivityClippingAncestors(element);
      const nextBounds = getActivityBounds(
        element.getBoundingClientRect(),
        getActivityViewport(window),
        clippingAncestors.map(({ clip }) => clip),
      );
      const next = {
        bounds: nextBounds,
        occluded: isActivityOccluded(document),
      };
      if (
        next.bounds?.x !== geometryRef.current.bounds?.x ||
        next.bounds?.y !== geometryRef.current.bounds?.y ||
        next.bounds?.width !== geometryRef.current.bounds?.width ||
        next.bounds?.height !== geometryRef.current.bounds?.height ||
        next.occluded !== geometryRef.current.occluded
      ) {
        geometryRef.current = next;
        setGeometry(next);
      }
      if (nextBounds) lastBoundsRef.current = nextBounds;
    };
    const scheduleMeasure = () => {
      if (isActivityOccluded(document)) {
        if (timer) clearTimeout(timer);
        measure();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, 40);
    };
    measure();
    const clippingAncestorElements = getActivityClippingAncestors(element).map(
      ({ element: ancestor }) => ancestor,
    );
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleMeasure);
    observer?.observe(element);
    clippingAncestorElements.forEach((ancestor) => observer?.observe(ancestor));
    window.addEventListener('resize', scheduleMeasure);
    document.addEventListener('scroll', scheduleMeasure, true);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('scroll', scheduleMeasure);
    const overlayObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(scheduleMeasure);
    overlayObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-open', 'data-state', 'style'],
      childList: true,
      subtree: true,
    });
    let scaleQuery =
      window.matchMedia?.(
        '(resolution: ' + window.devicePixelRatio + 'dppx)',
      ) ?? null;
    const onScaleChange = () => {
      scaleQuery?.removeEventListener('change', onScaleChange);
      scaleQuery =
        window.matchMedia?.(
          '(resolution: ' + window.devicePixelRatio + 'dppx)',
        ) ?? null;
      scaleQuery?.addEventListener('change', onScaleChange);
      scheduleMeasure();
    };
    scaleQuery?.addEventListener('change', onScaleChange);
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      overlayObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      document.removeEventListener('scroll', scheduleMeasure, true);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure);
      scaleQuery?.removeEventListener('change', onScaleChange);
    };
  }, [slotElement]);

  const canMount = Boolean(
    version?.available &&
    version.runtimeVersion === 1 &&
    savedState !== undefined &&
    geometry.bounds &&
    !geometry.occluded &&
    status !== 'unavailable' &&
    status !== 'unsupported',
  );

  useEffect(() => {
    if (!canMount || runIdRef.current) return;
    const initialBounds = geometryRef.current.bounds;
    if (!initialBounds) return;
    let cancelled = false;
    const operation = closeBarrierRef.current
      .then(() =>
        bridge.mountActivity({
          sessionId,
          artifactId,
          versionId,
          attemptId,
          presentation: presentationRef.current,
          readOnly,
          bounds: initialBounds,
        }),
      )
      .then(async ({ runId: nextRunId }) => {
        if (cancelled) {
          await bridge
            .updateActivityBounds({
              runId: nextRunId,
              bounds: initialBounds,
              visible: false,
            })
            .catch(() => undefined);
          await bridge
            .closeActivity({ runId: nextRunId })
            .catch(() => undefined);
          return;
        }
        runIdRef.current = nextRunId;
        setRunId(nextRunId);
        setStatus('starting');
        unsubscribeRef.current = bridge.onActivityChange(
          nextRunId,
          receiveRuntimeChange,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('runtime-error');
          setErrorCode('feature-unavailable');
          void closeCurrentRun();
        }
      });
    return () => {
      cancelled = true;
      if (!runIdRef.current)
        closeBarrierRef.current = operation.then(
          () => undefined,
          () => undefined,
        );
    };
  }, [
    accountId,
    artifactId,
    attemptId,
    bridge,
    canMount,
    receiveRuntimeChange,
    readOnly,
    retryNonce,
    sessionId,
    versionId,
  ]);

  useEffect(() => {
    if (geometry.bounds) return;
    void closeCurrentRun();
  }, [closeCurrentRun, geometry.bounds]);

  useEffect(() => {
    const activeRunId = runId;
    const bounds = geometry.bounds ?? lastBoundsRef.current;
    if (!activeRunId || !bounds) return;
    const visible = geometry.bounds !== null && !geometry.occluded;
    const signature = JSON.stringify({ activeRunId, bounds, visible });
    if (signature === lastBoundsRequestRef.current) return;
    const sendBounds = () => {
      if (signature === lastBoundsRequestRef.current) return;
      lastBoundsRequestRef.current = signature;
      void Promise.resolve()
        .then(() =>
          bridge.updateActivityBounds({
            runId: activeRunId,
            bounds,
            visible,
          }),
        )
        .catch(() => {
          setStatus('runtime-error');
          setErrorCode('feature-unavailable');
        });
    };
    if (!visible) {
      sendBounds();
      return;
    }
    const timer = setTimeout(sendBounds, 40);
    return () => clearTimeout(timer);
  }, [bridge, geometry, presentation, runId]);

  useEffect(
    () => () => {
      void closeCurrentRun();
    },
    [bridge, closeCurrentRun, readOnly, resourceKey],
  );

  const retry = useCallback(async () => {
    if (readOnly) return;
    const activeRunId = runIdRef.current;
    if (status === 'checkpoint-error' && activeRunId) {
      try {
        await bridge.retryActivityCheckpoint({ runId: activeRunId });
        setStatus('checkpoint-pending');
      } catch {
        setErrorCode('storage-failed');
      }
      return;
    }
    await closeCurrentRun();
    setStatus('starting');
    setErrorCode(null);
    setRetryNonce((value) => value + 1);
  }, [bridge, closeCurrentRun, readOnly, status]);

  const resetAttempt = useCallback(async () => {
    if (readOnly) throw new Error('Activity is read-only.');
    await closeCurrentRun();
    try {
      const nextState = await bridge.resetArtifactAttempt({
        artifactId,
        versionId,
        attemptId,
        requestId: createRequestId(),
      });
      setAttemptId(nextState.attemptId);
      setSavedState(nextState);
      setLastAcknowledgedRevision(nextState.stateRevision);
      setStatus('starting');
      setErrorCode(null);
      setRetryNonce((value) => value + 1);
    } catch (error) {
      setStatus('runtime-error');
      setErrorCode('feature-unavailable');
      setRetryNonce((value) => value + 1);
      throw error;
    }
  }, [artifactId, attemptId, bridge, closeCurrentRun, readOnly, versionId]);

  const saveArtifact = useCallback(
    async (courseId?: string | null) => {
      if (readOnly) throw new Error('Activity is read-only.');
      return bridge.saveArtifactToContext({
        artifactId,
        versionId,
        ...(courseId === undefined ? {} : { courseId }),
        requestId: createRequestId(),
      });
    },
    [artifactId, bridge, readOnly, versionId],
  );

  const slotBounds = geometry.bounds;
  const visible = slotBounds !== null && !geometry.occluded;
  const errorMessage = errorCode
    ? formatActivityRuntimeError(errorCode)
    : status === 'runtime-error'
      ? 'Your last saved progress is still available; reopen the activity to try again.'
      : null;

  return {
    version,
    savedState,
    attemptId,
    runId,
    status,
    errorCode,
    errorMessage,
    lastAcknowledgedRevision,
    visible,
    slotRef,
    retry,
    resetAttempt,
    saveArtifact,
    scrollAnchorFor: getActivityScrollAnchor,
    restoreScrollAnchor: restoreActivityScrollAnchor,
  };
};
