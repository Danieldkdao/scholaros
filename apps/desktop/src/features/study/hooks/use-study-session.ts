import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContextItemDTO,
  ContextVersionDTO,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';
import type { GradeSettings } from '@scholaros/services/learning/grade-contracts';
import type {
  LearningMethodContracts,
  ProductEventV1,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import { safeErrorCodes } from '@scholaros/services/learning/product-contracts';
import type {
  SessionSnapshot,
  StudyMessageDTO,
} from '@scholaros/services/learning/study-contracts';
import type { StudyAttachment } from '../components/study-composer';
import type { StudyTimerActions } from '../components/study-timer';
import {
  approvedPreviewMessage,
  isApprovedPreviewCurrent,
  receiveApprovedTutorOutput,
  type ApprovedTutorPreview,
} from '../lib/approved-tutor-preview';

type LearningMethodName =
  | 'getStudySession'
  | 'saveStudyDraft'
  | 'sendStudyTurn'
  | 'retryStudyTurn'
  | 'cancelStudyTurn'
  | 'getGradeSettings'
  | 'getContextItem'
  | 'reconcileStudyDeadline'
  | 'finishStudySession'
  | 'extendStudySession'
  | 'continueStudyUntimed';
type NullableReadMethod =
  | 'getStudySession'
  | 'getGradeSettings'
  | 'getContextItem';
type LearningBridgeMethods = {
  [Method in LearningMethodName]: (
    input: LearningMethodContracts[Method]['input'],
  ) => Promise<
    Method extends NullableReadMethod
      ? LearningMethodContracts[Method]['result'] | null
      : LearningMethodContracts[Method]['result']
  >;
};

type SelectedContextFiles = {
  items: { itemId: string; operationId: string; status: IngestionStatus }[];
  cancelled: boolean;
};
export type StudyBridge = Pick<typeof window.scholar, 'getCourse'> &
  LearningBridgeMethods & {
    onProductEvent: (listener: (event: ProductEventV1) => void) => () => void;
    chooseContextFiles: (input: {
      sessionId: string;
      courseId: string;
      saveToLibrary: false;
    }) => Promise<SelectedContextFiles>;
  };

export type StudyAttachmentDetails = StudyAttachment & {
  version: ContextVersionDTO | null;
};
export type StudySessionErrorCode =
  | SafeErrorCode
  | 'host-read-only'
  | 'unknown';
export type StudySessionState = {
  accountId: string | null;
  sessionId: string | null;
  loading: boolean;
  refreshing: boolean;
  snapshot: SessionSnapshot | null;
  courseName: string | null;
  gradeSettings: GradeSettings | null;
  errorCode: StudySessionErrorCode | null;
  refreshErrorCode: StudySessionErrorCode | null;
  olderMessagesLoading: boolean;
  olderMessagesErrorCode: StudySessionErrorCode | null;
  scrollAnchorId: string | null;
};

type StudySendInput = {
  text: string;
  attachmentIds: string[];
  expectedDraftRevision: number;
  composerRevision: number;
};
type StudySendResult = { turnId: string; draftRevision: number | null };
type StudyTimerActionMap = StudyTimerActions;

const isSafeErrorCode = (value: unknown): value is SafeErrorCode =>
  typeof value === 'string' && safeErrorCodes.includes(value as SafeErrorCode);

const getErrorCode = (error: unknown): StudySessionErrorCode => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (code === 'host-read-only') return code;
    return isSafeErrorCode(code) ? code : 'unknown';
  }
  return 'unknown';
};

export const formatStudySessionError = (
  code: StudySessionErrorCode,
  action: 'load' | 'refresh' | 'send' | 'save' | 'timer' | 'attachment',
) => {
  switch (code) {
    case 'invalid-input':
      return 'This session request is not valid.';
    case 'not-found':
      return 'This session is not available.';
    case 'scope-denied':
      return 'This session is not available for the current account.';
    case 'session-changed':
      return 'The account or session changed. Reopen the study session.';
    case 'permission-revoked':
      return 'Access changed before this action could finish.';
    case 'host-read-only':
      return 'Reconnect online to change this saved study session.';
    case 'busy':
      return 'Another session action is still finishing. Try again shortly.';
    case 'revision-conflict':
      return action === 'save'
        ? 'Your saved draft changed. Your typed text is still here; retry to save it.'
        : 'The session changed before this action could finish. Refresh and try again.';
    case 'cancelled':
      return action === 'send'
        ? 'The message was not sent. Your draft is still here.'
        : 'This action was stopped.';
    case 'offline':
      return action === 'send'
        ? 'You are offline. Your draft is safe; connect before sending.'
        : 'The local study service is unavailable. Try again when it reconnects.';
    case 'needs-sign-in':
      return 'Sign in again to reopen this study session.';
    case 'rate-limited':
      return 'Too many requests were made. Wait a moment and try again.';
    case 'capability-changed':
      return 'This operation is no longer available. Start a new request to continue.';
    case 'feature-unavailable':
      return 'This study feature is not available yet.';
    case 'unsupported':
      return action === 'attachment'
        ? 'This file type is not supported.'
        : 'This action is not supported.';
    case 'unreadable':
      return 'This source could not be read. Your other session content is unchanged.';
    case 'limit-exceeded':
      return 'This request exceeds the allowed size or duration.';
    case 'provider-failed':
      return 'The tutor could not respond. Your message is saved and can be retried.';
    case 'storage-failed':
      return action === 'save'
        ? 'Your draft could not be saved. Keep this screen open and retry.'
        : 'The session could not be updated. Your current content remains available.';
    case 'unknown':
      switch (action) {
        case 'load':
          return 'This study session could not be loaded.';
        case 'refresh':
          return 'The latest session updates could not be loaded.';
        case 'send':
          return 'This message could not be sent. Your draft is still here.';
        case 'save':
          return 'Your draft could not be saved. Keep this screen open and retry.';
        case 'timer':
          return 'The timer could not be updated. Your session remains available.';
        case 'attachment':
          return 'The selected files could not be added to this session.';
      }
  }
};

const createRequestId = () => globalThis.crypto.randomUUID();

const createHostReadOnlyError = () =>
  Object.assign(
    new Error('Reconnect online to change this saved study session.'),
    { code: 'host-read-only' as const },
  );

const mergeMessages = (
  currentMessages: StudyMessageDTO[],
  nextMessages: StudyMessageDTO[],
) => {
  const messages = new Map<string, StudyMessageDTO>();
  for (const message of currentMessages) messages.set(message.id, message);
  for (const message of nextMessages) messages.set(message.id, message);
  return [...messages.values()].sort(
    (first, second) => first.sequence - second.sequence,
  );
};

const mergeSourceReferences = (
  first: SessionSnapshot['sourceReferences'],
  second: SessionSnapshot['sourceReferences'],
) => {
  const references = new Map<
    string,
    SessionSnapshot['sourceReferences'][number]
  >();
  for (const reference of [...first, ...second]) {
    const key = [
      reference.sourceKind,
      reference.sourceId,
      reference.courseId ?? '',
      reference.versionId ?? '',
      reference.locator ? JSON.stringify(reference.locator) : '',
    ].join(':');
    references.set(key, reference);
  }
  return [...references.values()];
};

const mergeSnapshots = (
  currentSnapshot: SessionSnapshot | null,
  nextSnapshot: SessionSnapshot,
): SessionSnapshot => {
  if (
    !currentSnapshot ||
    currentSnapshot.session.id !== nextSnapshot.session.id
  )
    return nextSnapshot;
  return {
    ...nextSnapshot,
    messages: mergeMessages(currentSnapshot.messages, nextSnapshot.messages),
    sourceReferences: mergeSourceReferences(
      currentSnapshot.sourceReferences,
      nextSnapshot.sourceReferences,
    ),
    hasMoreBefore: nextSnapshot.hasMoreBefore,
  };
};

const toAttachment = async (
  bridge: StudyBridge,
  itemId: string,
  versionId?: string,
): Promise<StudyAttachmentDetails> => {
  const selected = await bridge.getContextItem({ itemId, versionId });
  if (!selected) {
    return {
      itemId,
      title: 'Attachment unavailable',
      status: 'failed',
      provenance: null,
      versionId: null,
      version: null,
      sourceRemoved: false,
    };
  }
  const resolvedVersionId = versionId ?? selected.item.currentVersionId;
  const version = resolvedVersionId
    ? (selected.versions.find(
        (candidate) => candidate.id === resolvedVersionId,
      ) ?? null)
    : null;
  const status = version?.extractionStatus ?? selected.item.status;
  const versionMissing = resolvedVersionId !== null && version === null;
  const completedWithoutVersion =
    (status === 'complete' || status === 'partial') &&
    resolvedVersionId === null;
  const unusableCompletedVersion =
    !selected.item.usable && (status === 'complete' || status === 'partial');
  const unavailable =
    selected.item.source?.removed === true ||
    versionMissing ||
    completedWithoutVersion ||
    unusableCompletedVersion;
  return {
    itemId,
    title: selected.item.source?.removed
      ? 'Source removed'
      : selected.item.title,
    status: unavailable ? 'failed' : status,
    provenance: selected.item.provenance,
    versionId: unavailable ? null : (version?.id ?? resolvedVersionId),
    version,
    sourceRemoved: selected.item.source?.removed ?? false,
  };
};

export const useStudySession = (
  accountId: string,
  sessionId: string,
  readOnly = false,
  refreshEpoch = 0,
) => {
  const scopeKey = JSON.stringify([accountId, sessionId, readOnly]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const snapshotScopeRef = useRef<string | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const requestSequenceRef = useRef(0);
  const requestIdsRef = useRef(new Map<string, string>());
  const previewRef = useRef<ApprovedTutorPreview | null>(null);
  const [approvedPreview, setApprovedPreview] =
    useState<ApprovedTutorPreview | null>(null);
  const stateRef = useRef<StudySessionState | null>(null);
  const [state, setState] = useState<StudySessionState>({
    accountId: null,
    sessionId: null,
    loading: true,
    refreshing: false,
    snapshot: null,
    courseName: null,
    gradeSettings: null,
    errorCode: null,
    refreshErrorCode: null,
    olderMessagesLoading: false,
    olderMessagesErrorCode: null,
    scrollAnchorId: null,
  });
  stateRef.current = state;
  const isStateForScope =
    state.accountId === accountId && state.sessionId === sessionId;

  const reload = useCallback(async (): Promise<SessionSnapshot | null> => {
    const sequence = ++requestSequenceRef.current;
    const requestedScope = JSON.stringify([accountId, sessionId, readOnly]);
    const isCurrentRequest = () =>
      requestSequenceRef.current === sequence &&
      scopeRef.current === requestedScope;
    const bridge = window.scholar as unknown as StudyBridge;
    const hasCurrentSnapshot =
      scopeRef.current === requestedScope &&
      stateRef.current?.accountId === accountId &&
      stateRef.current.sessionId === sessionId &&
      stateRef.current.snapshot?.session.id === sessionId;
    setState((previous) => ({
      ...previous,
      accountId,
      sessionId,
      loading: !hasCurrentSnapshot,
      refreshing: hasCurrentSnapshot,
      snapshot: hasCurrentSnapshot ? previous.snapshot : null,
      courseName: hasCurrentSnapshot ? previous.courseName : null,
      gradeSettings: hasCurrentSnapshot ? previous.gradeSettings : null,
      errorCode: null,
    }));
    try {
      const snapshot = await bridge.getStudySession({ sessionId, limit: 100 });
      if (!isCurrentRequest()) return null;
      if (!snapshot || snapshot.session.id !== sessionId) {
        const code = snapshot ? 'scope-denied' : 'unknown';
        setState((previous) => ({
          ...previous,
          accountId,
          sessionId,
          loading: false,
          refreshing: false,
          errorCode: hasCurrentSnapshot ? null : code,
          refreshErrorCode: hasCurrentSnapshot ? code : null,
        }));
        return null;
      }
      const [courseResult, gradeResult] = await Promise.allSettled([
        bridge.getCourse(snapshot.session.courseId),
        readOnly ? Promise.resolve(null) : bridge.getGradeSettings({}),
      ]);
      if (!isCurrentRequest()) return null;
      const currentSnapshot =
        scopeRef.current === requestedScope &&
        snapshotScopeRef.current === requestedScope &&
        stateRef.current?.accountId === accountId &&
        stateRef.current.sessionId === sessionId
          ? stateRef.current.snapshot
          : null;
      const mergedSnapshot = mergeSnapshots(currentSnapshot, snapshot);
      const course =
        courseResult.status === 'fulfilled' ? courseResult.value : null;
      const gradeSettings =
        readOnly &&
        stateRef.current?.accountId === accountId &&
        stateRef.current?.sessionId === sessionId
          ? (stateRef.current?.gradeSettings ?? null)
          : gradeResult.status === 'fulfilled'
            ? gradeResult.value
            : null;
      snapshotScopeRef.current = requestedScope;
      setState({
        accountId,
        sessionId,
        loading: false,
        refreshing: false,
        snapshot: mergedSnapshot,
        courseName: course?.name ?? null,
        gradeSettings,
        errorCode: null,
        refreshErrorCode: null,
        olderMessagesLoading: false,
        olderMessagesErrorCode: null,
        scrollAnchorId: stateRef.current?.scrollAnchorId ?? null,
      });
      return mergedSnapshot;
    } catch (error) {
      if (!isCurrentRequest()) return null;
      const code = getErrorCode(error);
      setState((previous) => ({
        ...previous,
        accountId,
        sessionId,
        loading: false,
        refreshing: false,
        errorCode: hasCurrentSnapshot ? null : code,
        refreshErrorCode: hasCurrentSnapshot ? code : null,
      }));
      return null;
    }
  }, [accountId, readOnly, sessionId]);

  useEffect(() => {
    const subscribedScope = JSON.stringify([accountId, sessionId, readOnly]);
    let unsubscribe: () => void = () => {};
    const bridge = window.scholar as unknown as StudyBridge;
    if (typeof bridge.onProductEvent === 'function') {
      unsubscribe = bridge.onProductEvent((event) => {
        if (
          scopeRef.current !== subscribedScope ||
          event.accountId !== accountId
        )
          return;
        if (
          event.resource === 'study' &&
          event.targetId &&
          event.targetId !== sessionId
        )
          return;
        if (!['study', 'grades', 'context', 'memory'].includes(event.resource))
          return;
        if (event.approvedTutorOutput) {
          const current = stateRef.current;
          if (
            event.resource !== 'study' ||
            event.targetId !== sessionId ||
            readOnlyRef.current
          )
            return;
          if (
            current?.accountId === accountId &&
            current.sessionId === sessionId &&
            current.snapshot
          ) {
            const preview = receiveApprovedTutorOutput(
              previewRef.current,
              event,
              scopeRef.current,
              current.snapshot,
              current.gradeSettings,
            );
            if (preview !== previewRef.current) {
              previewRef.current = preview;
              setApprovedPreview(preview);
            }
          }
          // Only the final delivery frame reads the durable message, including
          // its citations and activities. Chunks never cause snapshot reloads.
          if (event.approvedTutorOutput.done) void reload();
          return;
        }
        void reload();
      });
    }
    void reload();
    return () => {
      unsubscribe();
      requestSequenceRef.current += 1;
    };
  }, [accountId, readOnly, refreshEpoch, reload, sessionId]);

  const saveDraft = useCallback(
    async (text: string, expectedDraftRevision: number) => {
      if (readOnlyRef.current) throw createHostReadOnlyError();
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        return await bridge.saveStudyDraft({
          sessionId,
          text,
          expectedDraftRevision,
        });
      } catch (error) {
        throw Object.assign(
          new Error(formatStudySessionError(getErrorCode(error), 'save')),
          {
            code: getErrorCode(error),
          },
        );
      }
    },
    [sessionId],
  );

  const getRequestId = (key: string) => {
    const currentRequestId = requestIdsRef.current.get(key);
    if (currentRequestId) return currentRequestId;
    const requestId = createRequestId();
    requestIdsRef.current.set(key, requestId);
    return requestId;
  };

  const sendTurn = useCallback(
    async (input: StudySendInput): Promise<StudySendResult> => {
      if (readOnlyRef.current) throw createHostReadOnlyError();
      const requestedScope = JSON.stringify([accountId, sessionId, readOnly]);
      const requestKey = `turn:${accountId}:${sessionId}:${input.expectedDraftRevision}:${input.composerRevision}:${JSON.stringify(input.attachmentIds)}`;
      const requestId = getRequestId(requestKey);
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        const result = await bridge.sendStudyTurn({
          sessionId,
          requestId,
          expectedDraftRevision: input.expectedDraftRevision,
          text: input.text,
          attachmentIds: input.attachmentIds,
        });
        let refreshedSnapshot: SessionSnapshot | null = null;
        if (result.draftRevision === undefined) {
          refreshedSnapshot = await reload();
        } else if (scopeRef.current === requestedScope) {
          // Refresh the document independently; a slow read cannot hold Send open.
          void reload();
        }
        // The host acknowledges the draft revision in the same transaction as
        // admission. Product events may supersede this reload while inference
        // starts, so a superseded read must not turn an accepted Send into an error.
        const draftRevision =
          scopeRef.current === requestedScope
            ? (result.draftRevision ??
              refreshedSnapshot?.session.draft.revision ??
              null)
            : null;
        if (draftRevision !== null) requestIdsRef.current.delete(requestKey);
        return { turnId: result.turnId, draftRevision };
      } catch (error) {
        const code = getErrorCode(error);
        if (scopeRef.current === requestedScope && code === 'offline')
          setState((previous) => ({
            ...previous,
            refreshErrorCode: 'offline',
          }));
        throw Object.assign(new Error(formatStudySessionError(code, 'send')), {
          code,
        });
      }
    },
    [accountId, readOnly, reload, sessionId],
  );

  const retryTurn = useCallback(
    async (turnId: string) => {
      if (readOnlyRef.current) throw createHostReadOnlyError();
      const requestedScope = JSON.stringify([accountId, sessionId, readOnly]);
      const requestKey = `retry:${accountId}:${sessionId}:${turnId}`;
      const requestId = getRequestId(requestKey);
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        await bridge.retryStudyTurn({ sessionId, turnId, requestId });
        requestIdsRef.current.delete(requestKey);
        await reload();
      } catch (error) {
        const code = getErrorCode(error);
        if (scopeRef.current === requestedScope && code === 'offline')
          setState((previous) => ({
            ...previous,
            refreshErrorCode: 'offline',
          }));
        throw Object.assign(new Error(formatStudySessionError(code, 'send')), {
          code,
        });
      }
    },
    [accountId, readOnly, reload, sessionId],
  );

  const stopTurn = useCallback(
    async (turnId: string) => {
      if (readOnlyRef.current) throw createHostReadOnlyError();
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        await bridge.cancelStudyTurn({ sessionId, turnId });
        await reload();
      } catch (error) {
        throw Object.assign(
          new Error(formatStudySessionError(getErrorCode(error), 'send')),
          { code: getErrorCode(error) },
        );
      }
    },
    [accountId, readOnly, reload, sessionId],
  );

  const loadOlderMessages = useCallback(async () => {
    const currentSnapshot = state.snapshot;
    const firstMessage = currentSnapshot?.messages[0];
    if (!currentSnapshot?.hasMoreBefore || !firstMessage) return;
    const requestedScope = JSON.stringify([accountId, sessionId, readOnly]);
    const bridge = window.scholar as unknown as StudyBridge;
    setState((previous) => ({
      ...previous,
      olderMessagesLoading: true,
      olderMessagesErrorCode: null,
    }));
    try {
      const olderSnapshot = await bridge.getStudySession({
        sessionId,
        beforeSequence: firstMessage.sequence,
        limit: 100,
      });
      if (scopeRef.current !== requestedScope) return;
      if (!olderSnapshot || olderSnapshot.session.id !== sessionId) {
        setState((previous) => ({
          ...previous,
          olderMessagesLoading: false,
          olderMessagesErrorCode: 'unknown',
        }));
        return;
      }
      const latestSnapshot =
        stateRef.current?.accountId === accountId &&
        stateRef.current.sessionId === sessionId
          ? (stateRef.current.snapshot ?? currentSnapshot)
          : currentSnapshot;
      const mergedSnapshot = {
        ...latestSnapshot,
        messages: mergeMessages(
          latestSnapshot.messages,
          olderSnapshot.messages,
        ),
        sourceReferences: mergeSourceReferences(
          latestSnapshot.sourceReferences,
          olderSnapshot.sourceReferences,
        ),
        hasMoreBefore: olderSnapshot.hasMoreBefore,
      };
      setState((previous) => ({
        ...previous,
        snapshot: mergedSnapshot,
        olderMessagesLoading: false,
        olderMessagesErrorCode: null,
        scrollAnchorId: firstMessage.id,
      }));
    } catch (error) {
      if (scopeRef.current !== requestedScope) return;
      setState((previous) => ({
        ...previous,
        olderMessagesLoading: false,
        olderMessagesErrorCode: getErrorCode(error),
      }));
    }
  }, [accountId, readOnly, sessionId, state.snapshot]);

  const reconcileTimer = useCallback(async () => {
    if (readOnlyRef.current) throw createHostReadOnlyError();
    const bridge = window.scholar as unknown as StudyBridge;
    try {
      const timer = await bridge.reconcileStudyDeadline({ sessionId });
      await reload();
      return timer;
    } catch (error) {
      throw Object.assign(
        new Error(formatStudySessionError(getErrorCode(error), 'timer')),
        { code: getErrorCode(error) },
      );
    }
  }, [accountId, readOnly, reload, sessionId]);

  const finishTimer = useCallback(async () => {
    if (readOnlyRef.current) throw createHostReadOnlyError();
    const currentTimer = state.snapshot?.session.timer;
    if (!currentTimer) return;
    const key = `timer:finish:${accountId}:${sessionId}:${currentTimer.revision}`;
    const bridge = window.scholar as unknown as StudyBridge;
    try {
      await bridge.finishStudySession({
        sessionId,
        requestId: getRequestId(key),
        expectedTimerRevision: currentTimer.revision,
      });
      requestIdsRef.current.delete(key);
      await reload();
    } catch (error) {
      throw Object.assign(
        new Error(formatStudySessionError(getErrorCode(error), 'timer')),
        { code: getErrorCode(error) },
      );
    }
  }, [accountId, reload, sessionId, state.snapshot]);

  const extendTimer = useCallback(
    async (durationMinutes: number) => {
      if (readOnlyRef.current) throw createHostReadOnlyError();
      const currentTimer = state.snapshot?.session.timer;
      if (!currentTimer) return;
      const key = `timer:extend:${accountId}:${sessionId}:${currentTimer.revision}:${durationMinutes}`;
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        await bridge.extendStudySession({
          sessionId,
          requestId: getRequestId(key),
          expectedTimerRevision: currentTimer.revision,
          durationMinutes,
        });
        requestIdsRef.current.delete(key);
        await reload();
      } catch (error) {
        throw Object.assign(
          new Error(formatStudySessionError(getErrorCode(error), 'timer')),
          { code: getErrorCode(error) },
        );
      }
    },
    [accountId, reload, sessionId, state.snapshot],
  );

  const continueUntimed = useCallback(async () => {
    if (readOnlyRef.current) throw createHostReadOnlyError();
    const currentTimer = state.snapshot?.session.timer;
    if (!currentTimer) return;
    const key = `timer:continue:${accountId}:${sessionId}:${currentTimer.revision}`;
    const bridge = window.scholar as unknown as StudyBridge;
    try {
      await bridge.continueStudyUntimed({
        sessionId,
        requestId: getRequestId(key),
        expectedTimerRevision: currentTimer.revision,
      });
      requestIdsRef.current.delete(key);
      await reload();
    } catch (error) {
      throw Object.assign(
        new Error(formatStudySessionError(getErrorCode(error), 'timer')),
        { code: getErrorCode(error) },
      );
    }
  }, [accountId, reload, sessionId, state.snapshot]);

  const addAttachments = useCallback(async (): Promise<StudyAttachment[]> => {
    if (readOnlyRef.current) return [];
    const currentSession = state.snapshot?.session;
    if (!currentSession) return [];
    const bridge = window.scholar as unknown as StudyBridge;
    try {
      const selected = await bridge.chooseContextFiles({
        sessionId,
        courseId: currentSession.courseId,
        saveToLibrary: false,
      });
      if (selected.cancelled) return [];
      const attachments = await Promise.all(
        selected.items.map(async (item) => {
          try {
            return await toAttachment(bridge, item.itemId);
          } catch {
            return {
              itemId: item.itemId,
              title: 'Attachment unavailable',
              status: 'failed' as const,
              provenance: null,
              versionId: null,
              version: null,
              sourceRemoved: false,
            };
          }
        }),
      );
      return attachments.map(
        ({ version: _version, ...attachment }) => attachment,
      );
    } catch (error) {
      throw Object.assign(
        new Error(formatStudySessionError(getErrorCode(error), 'attachment')),
        { code: getErrorCode(error) },
      );
    }
  }, [accountId, readOnly, sessionId, state.snapshot]);

  const refreshAttachment = useCallback(
    async (attachment: StudyAttachment): Promise<StudyAttachment | null> => {
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        const refreshed = await toAttachment(
          bridge,
          attachment.itemId,
          attachment.versionId ?? undefined,
        );
        const { version: _version, ...result } = refreshed;
        return result;
      } catch {
        return {
          ...attachment,
          status: 'failed',
        };
      }
    },
    [],
  );

  const loadAttachment = useCallback(
    async (
      itemId: string,
      versionId: string,
    ): Promise<StudyAttachmentDetails | null> => {
      const bridge = window.scholar as unknown as StudyBridge;
      try {
        return await toAttachment(bridge, itemId, versionId);
      } catch {
        return null;
      }
    },
    [],
  );

  const timerActions: StudyTimerActionMap = {
    reconcile: reconcileTimer,
    finish: finishTimer,
    extend: extendTimer,
    continueUntimed,
  };
  const snapshot =
    isStateForScope && state.snapshot?.session.id === sessionId
      ? state.snapshot
      : null;
  const currentPreview =
    approvedPreview &&
    snapshot &&
    !readOnly &&
    isApprovedPreviewCurrent(
      approvedPreview,
      scopeKey,
      snapshot,
      state.gradeSettings,
    )
      ? approvedPreview
      : null;
  const displayedSnapshot =
    snapshot && currentPreview
      ? {
          ...snapshot,
          messages: mergeMessages(snapshot.messages, [
            approvedPreviewMessage(currentPreview, sessionId),
          ]),
        }
      : snapshot;
  const loading = !isStateForScope || state.loading;
  const errorCode = isStateForScope ? state.errorCode : null;
  const refreshErrorCode = isStateForScope ? state.refreshErrorCode : null;
  const gradeSettings = isStateForScope ? state.gradeSettings : null;

  return {
    loading,
    refreshing: isStateForScope && state.refreshing,
    snapshot: displayedSnapshot,
    streamingMessageId:
      currentPreview && !currentPreview.output.done
        ? currentPreview.output.messageId
        : null,
    courseName: isStateForScope ? state.courseName : null,
    gradeSettings,
    errorCode,
    refreshErrorCode,
    offline: errorCode === 'offline' || refreshErrorCode === 'offline',
    olderMessagesLoading: isStateForScope && state.olderMessagesLoading,
    olderMessagesErrorCode: isStateForScope
      ? state.olderMessagesErrorCode
      : null,
    scrollAnchorId: isStateForScope ? state.scrollAnchorId : null,
    reload,
    saveDraft,
    sendTurn,
    retryTurn,
    stopTurn,
    loadOlderMessages,
    timerActions,
    addAttachments,
    refreshAttachment,
    loadAttachment,
  };
};

export type { ContextItemDTO };
