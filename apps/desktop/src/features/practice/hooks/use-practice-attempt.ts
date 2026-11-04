import { useEffect, useRef, useState } from 'react';
import type {
  JsonValue,
  LearningMethodContracts,
} from '@scholaros/services/learning/product-contracts';
import type { PracticeSnapshot } from '@scholaros/services/learning/practice-contracts';
import type { PracticeAnswerSaveState } from '../lib/formatters';

type PracticeMethodName =
  | 'getPracticeAttempt'
  | 'savePracticeAnswer'
  | 'submitPracticeAttempt'
  | 'switchPracticeToGuided'
  | 'retryPracticeAttempt';

type PracticeBridge = {
  [Method in PracticeMethodName]: (
    input: LearningMethodContracts[Method]['input'],
  ) => Promise<LearningMethodContracts[Method]['result']>;
};

type PracticeScope = {
  key: string;
  sessionId: string | null;
};

type PracticeCommand = {
  attemptId: string;
  expectedRevision: number | null;
  requestId: string;
  value?: string;
  promise: Promise<boolean> | null;
};

type UsePracticeAttemptProps = {
  accountId: string;
  sessionId: string | null;
  attemptId: string;
  readOnly?: boolean;
  onAttemptChange?: (attemptId: string) => void;
};

export type UsePracticeAttemptResult = {
  snapshot: PracticeSnapshot | null;
  activeAttemptId: string;
  isLoading: boolean;
  loadError: string | null;
  actionError: string | null;
  answerDrafts: Record<string, string>;
  answerSaveStates: Record<string, PracticeAnswerSaveState>;
  answerErrors: Record<string, string | null>;
  isSubmitting: boolean;
  isSwitchingToGuided: boolean;
  isRetrying: boolean;
  reload: () => Promise<void>;
  changeAnswer: (questionId: string, value: string) => void;
  retryAnswerSave: (questionId: string) => void;
  submit: () => Promise<void>;
  switchToGuided: () => Promise<void>;
  retry: () => Promise<void>;
};

const practiceBridge = () =>
  window.scholar as typeof window.scholar & PracticeBridge;

const answerText = (value: JsonValue) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
};

const newRequestId = () => globalThis.crypto.randomUUID();

const isRevisionConflict = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return error instanceof Error && error.message === 'revision-conflict';
  return error.code === 'revision-conflict';
};

export const usePracticeAttempt = ({
  accountId,
  sessionId,
  attemptId,
  readOnly = false,
  onAttemptChange,
}: UsePracticeAttemptProps): UsePracticeAttemptResult => {
  const scopeKey = JSON.stringify([accountId, sessionId, attemptId]);
  const scopeRef = useRef<PracticeScope>({ key: scopeKey, sessionId });
  scopeRef.current = { key: scopeKey, sessionId };
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const previousReadOnlyRef = useRef(readOnly);
  const onAttemptChangeRef = useRef(onAttemptChange);
  onAttemptChangeRef.current = onAttemptChange;
  const generationRef = useRef(0);
  const readSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const activeAttemptIdRef = useRef(attemptId);
  const snapshotRef = useRef<PracticeSnapshot | null>(null);
  const savedAnswersRef = useRef(new Map<string, string>());
  const answerDraftsRef = useRef(new Map<string, string>());
  const pendingAnswersRef = useRef(new Map<string, PracticeCommand>());
  const saveTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const commandQueueRef = useRef(Promise.resolve());
  const submitCommandRef = useRef<PracticeCommand | null>(null);
  const guidedCommandRef = useRef<PracticeCommand | null>(null);
  const retryCommandRef = useRef<PracticeCommand | null>(null);
  const pendingAttemptChangeRef = useRef<string | null>(null);
  const saveAnswerRef = useRef<
    (questionId: string, value: string) => Promise<boolean>
  >(async () => false);
  const [snapshot, setSnapshot] = useState<PracticeSnapshot | null>(null);
  const [activeAttemptId, setActiveAttemptId] = useState(attemptId);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerSaveStates, setAnswerSaveStates] = useState<
    Record<string, PracticeAnswerSaveState>
  >({});
  const [answerErrors, setAnswerErrors] = useState<
    Record<string, string | null>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitchingToGuided, setIsSwitchingToGuided] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const currentSnapshot = loadedScope === scopeKey ? snapshot : null;

  const isCurrentScope = (key: string, generation: number) =>
    scopeRef.current.key === key && generationRef.current === generation;

  const setCurrentSnapshot = (next: PracticeSnapshot) => {
    snapshotRef.current = next;
    if (mountedRef.current) setSnapshot(next);
  };

  const hydrateSnapshot = (next: PracticeSnapshot) => {
    const nextDrafts = new Map<string, string>();
    const nextSaved = new Map<string, string>();
    const nextStates: Record<string, PracticeAnswerSaveState> = {};
    const nextErrors: Record<string, string | null> = {};

    for (const question of next.questions) {
      const answer = next.answers.find(
        (candidate) => candidate.questionId === question.id,
      );
      if (answer) {
        const value = answerText(answer.value);
        nextDrafts.set(question.id, value);
        nextSaved.set(question.id, value);
        nextStates[question.id] = 'saved';
      } else {
        nextDrafts.set(question.id, '');
        nextStates[question.id] = 'empty';
      }
      nextErrors[question.id] = null;
    }

    answerDraftsRef.current = nextDrafts;
    savedAnswersRef.current = nextSaved;
    pendingAnswersRef.current.clear();
    setCurrentSnapshot(next);
    if (!mountedRef.current) return;
    setAnswerDrafts(Object.fromEntries(nextDrafts));
    setAnswerSaveStates(nextStates);
    setAnswerErrors(nextErrors);
  };

  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = commandQueueRef.current.then(operation, operation);
    commandQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const updateSavedAnswers = (next: PracticeSnapshot) => {
    savedAnswersRef.current = new Map(
      next.answers.map((answer) => [
        answer.questionId,
        answerText(answer.value),
      ]),
    );
  };

  const saveAnswer = async (questionId: string, value: string) => {
    if (readOnlyRef.current) return false;
    const commandAttemptId = activeAttemptIdRef.current;
    const commandScope = scopeRef.current.key;
    const generation = generationRef.current;
    const current = snapshotRef.current;

    if (
      !current ||
      current.id !== commandAttemptId ||
      current.status !== 'in-progress'
    )
      return false;
    if (savedAnswersRef.current.get(questionId) === value) return true;
    if (!savedAnswersRef.current.has(questionId) && value === '') return true;

    let command = pendingAnswersRef.current.get(questionId);
    if (!command || command.value !== value) {
      command = {
        attemptId: commandAttemptId,
        expectedRevision: null,
        requestId: newRequestId(),
        value,
        promise: null,
      };
      pendingAnswersRef.current.set(questionId, command);
    }
    if (command.promise) return command.promise;

    if (mountedRef.current) {
      setAnswerSaveStates((currentStates) => ({
        ...currentStates,
        [questionId]: 'saving',
      }));
      setAnswerErrors((currentErrors) => ({
        ...currentErrors,
        [questionId]: null,
      }));
    }

    const queuedSave = enqueue(async () => {
      if (
        readOnlyRef.current ||
        !isCurrentScope(commandScope, generation) ||
        activeAttemptIdRef.current !== commandAttemptId
      )
        return false;
      const latestSnapshot = snapshotRef.current;
      if (
        !latestSnapshot ||
        latestSnapshot.id !== commandAttemptId ||
        latestSnapshot.status !== 'in-progress'
      )
        return false;

      if (command.expectedRevision === null)
        command.expectedRevision = latestSnapshot.revision;

      try {
        const updated = await practiceBridge().savePracticeAnswer({
          attemptId: commandAttemptId,
          questionId,
          expectedRevision: command.expectedRevision,
          value: value as JsonValue,
          requestId: command.requestId,
        });
        if (!isCurrentScope(commandScope, generation)) return false;
        if (updated.id !== commandAttemptId)
          throw new Error('The saved answer returned a different attempt.');
        const persistedAnswer = updated.answers.find(
          (answer) => answer.questionId === questionId,
        );
        if (!persistedAnswer || answerText(persistedAnswer.value) !== value)
          throw new Error('The saved answer could not be confirmed.');

        updateSavedAnswers(updated);
        setCurrentSnapshot(updated);
        if (pendingAnswersRef.current.get(questionId) === command)
          pendingAnswersRef.current.delete(questionId);

        if (answerDraftsRef.current.get(questionId) === value) {
          if (mountedRef.current) {
            setAnswerSaveStates((currentStates) => ({
              ...currentStates,
              [questionId]: 'saved',
            }));
            setAnswerErrors((currentErrors) => ({
              ...currentErrors,
              [questionId]: null,
            }));
          }
        } else if (mountedRef.current) {
          setAnswerSaveStates((currentStates) => ({
            ...currentStates,
            [questionId]: 'saving',
          }));
          const latestValue = answerDraftsRef.current.get(questionId);
          if (
            !readOnlyRef.current &&
            latestValue !== undefined &&
            !saveTimersRef.current.has(questionId)
          ) {
            const timer = setTimeout(() => {
              saveTimersRef.current.delete(questionId);
              void saveAnswerRef.current(questionId, latestValue);
            }, 500);
            saveTimersRef.current.set(questionId, timer);
          }
        }
        return true;
      } catch (error) {
        if (!isCurrentScope(commandScope, generation)) return false;
        if (isRevisionConflict(error)) {
          if (pendingAnswersRef.current.get(questionId) === command)
            pendingAnswersRef.current.delete(questionId);
          try {
            const readSequence = readSequenceRef.current;
            const latest = await practiceBridge().getPracticeAttempt({
              attemptId: commandAttemptId,
            });
            if (
              latest &&
              isCurrentScope(commandScope, generation) &&
              readSequenceRef.current === readSequence
            ) {
              updateSavedAnswers(latest);
              setCurrentSnapshot(latest);
            }
          } catch {
            // Keep the local draft even when the latest server revision is unavailable.
          }
          if (mountedRef.current) {
            setAnswerSaveStates((currentStates) => ({
              ...currentStates,
              [questionId]: 'error',
            }));
            setAnswerErrors((currentErrors) => ({
              ...currentErrors,
              [questionId]:
                'This attempt changed elsewhere. Your answer is kept here; retry to save it.',
            }));
          }
        } else {
          const latestValue = answerDraftsRef.current.get(questionId);
          const draftChanged =
            latestValue !== undefined && latestValue !== value;
          if (
            draftChanged &&
            pendingAnswersRef.current.get(questionId) === command
          )
            pendingAnswersRef.current.delete(questionId);
          if (mountedRef.current) {
            setAnswerSaveStates((currentStates) => ({
              ...currentStates,
              [questionId]: draftChanged ? 'saving' : 'error',
            }));
            if (draftChanged) {
              setAnswerErrors((currentErrors) => ({
                ...currentErrors,
                [questionId]: null,
              }));
              if (!saveTimersRef.current.has(questionId)) {
                const timer = setTimeout(() => {
                  saveTimersRef.current.delete(questionId);
                  void saveAnswerRef.current(questionId, latestValue);
                }, 0);
                saveTimersRef.current.set(questionId, timer);
              }
            } else {
              setAnswerErrors((currentErrors) => ({
                ...currentErrors,
                [questionId]:
                  'Could not save this answer. Your response is kept here; retry when you are ready.',
              }));
            }
          }
        }
        return false;
      }
    });
    command.promise = queuedSave;
    const saved = await queuedSave;
    if (command.promise === queuedSave) command.promise = null;
    return saved;
  };
  saveAnswerRef.current = saveAnswer;

  const readAttempt = async (
    requestedAttemptId: string,
    key: string,
    generation: number,
    shouldHydrate: boolean,
  ) => {
    const requestSequence = ++readSequenceRef.current;
    const isCurrentRead = () =>
      readSequenceRef.current === requestSequence &&
      isCurrentScope(key, generation);
    try {
      const loaded = await practiceBridge().getPracticeAttempt({
        attemptId: requestedAttemptId,
      });
      if (!mountedRef.current || !isCurrentRead()) return;
      if (
        !loaded ||
        loaded.id !== requestedAttemptId ||
        (scopeRef.current.sessionId !== null &&
          loaded.sessionId !== scopeRef.current.sessionId)
      ) {
        setLoadError('This practice attempt is unavailable.');
        return;
      }
      if (shouldHydrate) {
        hydrateSnapshot(loaded);
        setLoadedScope(key);
      } else {
        updateSavedAnswers(loaded);
        setCurrentSnapshot(loaded);
      }
      setActionError(null);
      setLoadError(null);
    } catch {
      if (!mountedRef.current || !isCurrentRead()) return;
      if (!snapshotRef.current)
        setLoadError(
          'Could not load this practice attempt. Check your connection and try again.',
        );
      else
        setActionError(
          'Could not check this attempt. Your saved answers are unchanged.',
        );
    }
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const key = scopeKey;
    const readSequence = ++readSequenceRef.current;
    const isCurrentRead = () =>
      readSequenceRef.current === readSequence &&
      isCurrentScope(key, generation);
    mountedRef.current = true;
    activeAttemptIdRef.current = attemptId;
    setActiveAttemptId(attemptId);
    snapshotRef.current = null;
    savedAnswersRef.current.clear();
    answerDraftsRef.current.clear();
    pendingAnswersRef.current.clear();
    submitCommandRef.current = null;
    guidedCommandRef.current = null;
    retryCommandRef.current = null;
    pendingAttemptChangeRef.current = null;
    setSnapshot(null);
    setLoadedScope(null);
    setAnswerDrafts({});
    setAnswerSaveStates({});
    setAnswerErrors({});
    setLoadError(null);
    setActionError(null);
    setIsLoading(true);
    setIsSubmitting(false);
    setIsSwitchingToGuided(false);
    setIsRetrying(false);

    void practiceBridge()
      .getPracticeAttempt({ attemptId })
      .then((loaded) => {
        if (!mountedRef.current || !isCurrentRead()) return;
        if (
          !loaded ||
          loaded.id !== attemptId ||
          (sessionId !== null && loaded.sessionId !== sessionId)
        ) {
          setLoadError('This practice attempt is unavailable.');
          return;
        }
        hydrateSnapshot(loaded);
        setLoadedScope(key);
      })
      .catch(() => {
        if (mountedRef.current && isCurrentRead())
          setLoadError(
            'Could not load this practice attempt. Check your connection and try again.',
          );
      })
      .finally(() => {
        if (mountedRef.current && isCurrentRead()) setIsLoading(false);
      });

    return () => {
      const sameScope = scopeRef.current.key === key;
      mountedRef.current = false;
      for (const [questionId, timer] of saveTimersRef.current) {
        clearTimeout(timer);
        saveTimersRef.current.delete(questionId);
        if (sameScope) {
          const value = answerDraftsRef.current.get(questionId);
          if (value !== undefined)
            void saveAnswerRef.current(questionId, value);
        }
      }
    };
  }, [accountId, sessionId, attemptId, scopeKey]);

  const clearSaveTimer = (questionId: string) => {
    const timer = saveTimersRef.current.get(questionId);
    if (timer !== undefined) clearTimeout(timer);
    saveTimersRef.current.delete(questionId);
  };

  const schedulePendingAnswers = () => {
    if (readOnlyRef.current) return;
    for (const [questionId, value] of answerDraftsRef.current) {
      const hasSavedAnswer = savedAnswersRef.current.has(questionId);
      if (
        (hasSavedAnswer && savedAnswersRef.current.get(questionId) === value) ||
        (!hasSavedAnswer && value === '') ||
        saveTimersRef.current.has(questionId)
      )
        continue;
      const timer = setTimeout(() => {
        saveTimersRef.current.delete(questionId);
        void saveAnswerRef.current(questionId, value);
      }, 500);
      saveTimersRef.current.set(questionId, timer);
    }
  };

  useEffect(() => {
    const modeChanged = previousReadOnlyRef.current !== readOnly;
    previousReadOnlyRef.current = readOnly;
    if (!modeChanged) return;
    if (readOnly) {
      for (const [questionId, timer] of saveTimersRef.current) {
        clearTimeout(timer);
        saveTimersRef.current.delete(questionId);
      }
    }

    const key = scopeRef.current.key;
    const generation = generationRef.current;
    const refresh = readAttempt(
      activeAttemptIdRef.current,
      key,
      generation,
      snapshotRef.current === null,
    );
    const requestSequence = readSequenceRef.current;
    void refresh.then(() => {
      if (
        !mountedRef.current ||
        !isCurrentScope(key, generation) ||
        readSequenceRef.current !== requestSequence
      )
        return;
      setIsLoading(false);
      if (readOnlyRef.current) return;
      const pendingAttemptId = pendingAttemptChangeRef.current;
      if (pendingAttemptId) {
        pendingAttemptChangeRef.current = null;
        onAttemptChangeRef.current?.(pendingAttemptId);
        return;
      }
      schedulePendingAnswers();
    });
  }, [readOnly]);

  const flushAnswer = async (questionId: string) => {
    if (readOnlyRef.current) return false;
    clearSaveTimer(questionId);
    const value = answerDraftsRef.current.get(questionId) ?? '';
    if (savedAnswersRef.current.get(questionId) === value) return true;
    if (!savedAnswersRef.current.has(questionId) && value === '') return true;
    return saveAnswerRef.current(questionId, value);
  };

  const flushAllAnswers = async () => {
    if (readOnlyRef.current) return false;
    const current = snapshotRef.current;
    if (!current) return false;
    const results = await Promise.all(
      current.questions.map((question) => flushAnswer(question.id)),
    );
    await commandQueueRef.current;
    if (readOnlyRef.current) return false;
    if (results.some((result) => !result)) return false;
    return current.questions.every((question) => {
      const value = answerDraftsRef.current.get(question.id) ?? '';
      return (
        savedAnswersRef.current.get(question.id) === value ||
        (!savedAnswersRef.current.has(question.id) && value === '')
      );
    });
  };

  const changeAnswer = (questionId: string, value: string) => {
    if (readOnlyRef.current) return;
    answerDraftsRef.current.set(questionId, value);
    setAnswerDrafts((currentDrafts) => ({
      ...currentDrafts,
      [questionId]: value,
    }));
    setAnswerErrors((currentErrors) => ({
      ...currentErrors,
      [questionId]: null,
    }));
    clearSaveTimer(questionId);

    if (savedAnswersRef.current.get(questionId) === value) {
      const pending = pendingAnswersRef.current.get(questionId);
      if (!pending?.promise) pendingAnswersRef.current.delete(questionId);
      setAnswerSaveStates((currentStates) => ({
        ...currentStates,
        [questionId]: pending?.promise ? 'saving' : 'saved',
      }));
      return;
    }
    if (!savedAnswersRef.current.has(questionId) && value === '') {
      setAnswerSaveStates((currentStates) => ({
        ...currentStates,
        [questionId]: 'empty',
      }));
      return;
    }

    setAnswerSaveStates((currentStates) => ({
      ...currentStates,
      [questionId]: 'saving',
    }));
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(questionId);
      void saveAnswerRef.current(questionId, value);
    }, 500);
    saveTimersRef.current.set(questionId, timer);
  };

  const retryAnswerSave = (questionId: string) => {
    if (readOnlyRef.current) return;
    clearSaveTimer(questionId);
    const value = answerDraftsRef.current.get(questionId) ?? '';
    void saveAnswerRef.current(questionId, value);
  };

  const reload = async () => {
    setIsLoading(true);
    setLoadError(null);
    const generation = generationRef.current;
    const key = scopeRef.current.key;
    await readAttempt(activeAttemptIdRef.current, key, generation, true);
    if (mountedRef.current && isCurrentScope(key, generation))
      setIsLoading(false);
  };

  const submit = async () => {
    const current = snapshotRef.current;
    if (
      readOnlyRef.current ||
      !current ||
      current.status !== 'in-progress' ||
      isSubmitting
    )
      return;
    const commandScope = scopeRef.current.key;
    const generation = generationRef.current;
    const commandAttemptId = current.id;
    setIsSubmitting(true);
    setActionError(null);
    try {
      const saved = await flushAllAnswers();
      if (
        readOnlyRef.current ||
        !isCurrentScope(commandScope, generation) ||
        activeAttemptIdRef.current !== commandAttemptId
      )
        return;
      if (!saved) {
        setActionError(
          'Save your pending answers before submitting. Your responses are still here.',
        );
        return;
      }
      const latest = snapshotRef.current;
      if (!latest || latest.id !== commandAttemptId) return;
      let command = submitCommandRef.current;
      if (
        !command ||
        command.attemptId !== latest.id ||
        command.expectedRevision !== latest.revision
      ) {
        command = {
          attemptId: latest.id,
          expectedRevision: latest.revision,
          requestId: newRequestId(),
          promise: null,
        };
        submitCommandRef.current = command;
      }
      const updated = await practiceBridge().submitPracticeAttempt({
        attemptId: command.attemptId,
        expectedRevision: command.expectedRevision!,
        requestId: command.requestId,
      });
      if (!isCurrentScope(commandScope, generation)) return;
      if (updated.id !== commandAttemptId)
        throw new Error('Submission returned a different attempt.');
      setCurrentSnapshot(updated);
      if (mountedRef.current) setActionError(null);
      submitCommandRef.current = null;
    } catch {
      try {
        const recovered = await practiceBridge().getPracticeAttempt({
          attemptId: commandAttemptId,
        });
        if (
          mountedRef.current &&
          isCurrentScope(commandScope, generation) &&
          recovered.id === commandAttemptId
        )
          setCurrentSnapshot(recovered);
      } catch {
        /* Saved answers remain available; later polling can recover. */
      }
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setActionError(
          'Could not submit your answers. Your saved responses are still here; check your connection and try again.',
        );
    } finally {
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setIsSubmitting(false);
    }
  };

  const switchToGuided = async () => {
    const current = snapshotRef.current;
    if (
      readOnlyRef.current ||
      !current ||
      current.status !== 'in-progress' ||
      isSwitchingToGuided
    )
      return;
    const commandScope = scopeRef.current.key;
    const generation = generationRef.current;
    const commandAttemptId = current.id;
    setIsSwitchingToGuided(true);
    setActionError(null);
    try {
      const saved = await flushAllAnswers();
      if (
        readOnlyRef.current ||
        !isCurrentScope(commandScope, generation) ||
        activeAttemptIdRef.current !== commandAttemptId
      )
        return;
      if (!saved) {
        setActionError(
          'Save your pending answers before switching to guided practice.',
        );
        return;
      }
      const latest = snapshotRef.current;
      if (!latest || latest.id !== commandAttemptId) return;
      let command = guidedCommandRef.current;
      if (
        !command ||
        command.attemptId !== latest.id ||
        command.expectedRevision !== latest.revision
      ) {
        command = {
          attemptId: latest.id,
          expectedRevision: latest.revision,
          requestId: newRequestId(),
          promise: null,
        };
        guidedCommandRef.current = command;
      }
      const updated = await practiceBridge().switchPracticeToGuided({
        attemptId: command.attemptId,
        expectedRevision: command.expectedRevision!,
        requestId: command.requestId,
      });
      if (!isCurrentScope(commandScope, generation)) return;
      if (
        updated.id !== commandAttemptId ||
        updated.mode !== 'guided' ||
        !updated.assisted
      )
        throw new Error('Guided practice could not be confirmed.');
      setCurrentSnapshot(updated);
      guidedCommandRef.current = null;
    } catch {
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setActionError(
          'Could not switch to guided practice. This attempt remains unchanged; try again when ready.',
        );
    } finally {
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setIsSwitchingToGuided(false);
    }
  };

  const retry = async () => {
    const current = snapshotRef.current;
    if (
      readOnlyRef.current ||
      !current ||
      (current.status !== 'evaluated' &&
        current.status !== 'interrupted' &&
        current.status !== 'submitted') ||
      isSubmitting ||
      isRetrying
    )
      return;
    const commandScope = scopeRef.current.key;
    const generation = generationRef.current;
    const commandAttemptId = current.id;
    setIsRetrying(true);
    setActionError(null);
    let command = retryCommandRef.current;
    if (!command || command.attemptId !== current.id) {
      command = {
        attemptId: current.id,
        expectedRevision: null,
        requestId: newRequestId(),
        promise: null,
      };
      retryCommandRef.current = command;
    }
    try {
      const updated = await practiceBridge().retryPracticeAttempt({
        attemptId: command.attemptId,
        requestId: command.requestId,
      });
      if (
        !isCurrentScope(commandScope, generation) ||
        activeAttemptIdRef.current !== commandAttemptId
      )
        return;
      if (updated.priorAttemptId !== commandAttemptId)
        throw new Error('The previous attempt was not preserved.');
      activeAttemptIdRef.current = updated.id;
      if (mountedRef.current) setActiveAttemptId(updated.id);
      hydrateSnapshot(updated);
      retryCommandRef.current = null;
      if (mountedRef.current) setActionError(null);
      if (readOnlyRef.current && onAttemptChangeRef.current)
        pendingAttemptChangeRef.current = updated.id;
      else onAttemptChangeRef.current?.(updated.id);
    } catch {
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setActionError(
          'Could not create fresh practice. Your previous answers are preserved. Reconnect or reopen the source material in its study session, then try again.',
        );
    } finally {
      if (mountedRef.current && isCurrentScope(commandScope, generation))
        setIsRetrying(false);
    }
  };

  useEffect(() => {
    if (readOnly || !currentSnapshot || currentSnapshot.status !== 'submitted')
      return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    const key = scopeRef.current.key;
    const generation = generationRef.current;
    const poll = async () => {
      try {
        const updated = await practiceBridge().getPracticeAttempt({
          attemptId: activeAttemptId,
        });
        if (stopped || !isCurrentScope(key, generation)) return;
        if (updated && updated.id === activeAttemptId) {
          updateSavedAnswers(updated);
          setCurrentSnapshot(updated);
          if (updated.status !== 'submitted') setActionError(null);
        }
      } catch {
        if (!stopped && mountedRef.current)
          setActionError(
            'Evaluation is still being checked. Your submitted answers are saved.',
          );
      }
      if (!stopped && snapshotRef.current?.status === 'submitted') {
        timeout = setTimeout(poll, delay);
        delay = Math.min(delay * 2, 10_000);
      }
    };
    timeout = setTimeout(poll, delay);
    return () => {
      stopped = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [
    activeAttemptId,
    currentSnapshot?.id,
    currentSnapshot?.revision,
    currentSnapshot?.status,
    readOnly,
  ]);

  return {
    snapshot: currentSnapshot,
    activeAttemptId,
    isLoading: isLoading || loadedScope !== scopeKey,
    loadError,
    actionError,
    answerDrafts,
    answerSaveStates,
    answerErrors,
    isSubmitting,
    isSwitchingToGuided,
    isRetrying,
    reload,
    changeAnswer,
    retryAnswerSave,
    submit,
    switchToGuided,
    retry,
  };
};
