export type DictationEventBase = {
  version: 1;
  operationId: string;
  sessionId: string;
  composerRevision: number;
  sequence: number;
};

export type DictationEvent =
  | (DictationEventBase & { kind: 'ready' | 'ended' })
  | (DictationEventBase & { kind: 'partial' | 'final'; text: string })
  | (DictationEventBase & { kind: 'error'; errorCode: string });

export type DraftSelection = {
  start: number;
  end: number;
};

export type TranscriptCapture = {
  operationId: string;
  sessionId: string;
  composerRevision: number;
  selection: DraftSelection;
};

export type AcceptedTranscript = {
  text: string;
  composerRevision: number;
  selection: DraftSelection;
};

export type TranscriptState = {
  capture: TranscriptCapture;
  lastSequence: number;
  status: 'recording' | 'final' | 'ended' | 'empty' | 'failed' | 'cancelled';
  provisionalText: string;
  final: AcceptedTranscript | null;
  errorCode: string | null;
};

export type TranscriptUpdate = {
  state: TranscriptState;
  acceptedFinal: AcceptedTranscript | null;
};

const isValidEvent = (state: TranscriptState, event: DictationEvent) =>
  event.version === 1 &&
  event.operationId === state.capture.operationId &&
  event.sessionId === state.capture.sessionId &&
  event.composerRevision === state.capture.composerRevision &&
  Number.isSafeInteger(event.sequence) &&
  event.sequence > state.lastSequence;

export const createTranscriptState = (
  capture: TranscriptCapture,
): TranscriptState => ({
  capture,
  lastSequence: -1,
  status: 'recording',
  provisionalText: '',
  final: null,
  errorCode: null,
});

export const applyDictationEvent = (
  state: TranscriptState,
  event: DictationEvent,
): TranscriptUpdate => {
  if (
    state.status === 'cancelled' ||
    state.status === 'empty' ||
    state.status === 'ended' ||
    state.status === 'failed' ||
    !isValidEvent(state, event)
  )
    return { state, acceptedFinal: null };

  const nextState = { ...state, lastSequence: event.sequence };
  switch (event.kind) {
    case 'ready':
      return { state: nextState, acceptedFinal: null };
    case 'partial':
      if (state.final) return { state, acceptedFinal: null };
      return {
        state: { ...nextState, provisionalText: event.text },
        acceptedFinal: null,
      };
    case 'final': {
      if (state.final) return { state, acceptedFinal: null };
      if (!event.text.trim())
        return {
          state: { ...nextState, status: 'empty', provisionalText: '' },
          acceptedFinal: null,
        };
      const acceptedFinal = {
        text: event.text,
        composerRevision: state.capture.composerRevision,
        selection: state.capture.selection,
      };
      return {
        state: {
          ...nextState,
          status: 'final',
          provisionalText: '',
          final: acceptedFinal,
        },
        acceptedFinal,
      };
    }
    case 'error':
      if (state.final) return { state, acceptedFinal: null };
      return {
        state: {
          ...nextState,
          status: 'failed',
          provisionalText: '',
          errorCode: event.errorCode,
        },
        acceptedFinal: null,
      };
    case 'ended':
      return {
        state: {
          ...nextState,
          status: 'ended',
          provisionalText: '',
        },
        acceptedFinal: null,
      };
    default: {
      const exhaustive: never = event;
      return { state, acceptedFinal: exhaustive };
    }
  }
};

export const cancelTranscript = (state: TranscriptState): TranscriptState => ({
  ...state,
  status: 'cancelled',
  provisionalText: '',
});
