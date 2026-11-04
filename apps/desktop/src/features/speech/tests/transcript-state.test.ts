import { describe, expect, it } from 'vitest';
import {
  applyDictationEvent,
  cancelTranscript,
  createTranscriptState,
} from '../lib/transcript-state';
import type { DictationEvent } from '../lib/transcript-state';

const capture = {
  operationId: 'operation-a',
  sessionId: 'session-a',
  composerRevision: 4,
  selection: { start: 3, end: 3 },
};

const event = (
  sequence: number,
  kind: DictationEvent['kind'],
  payload: Partial<DictationEvent> = {},
): DictationEvent =>
  ({
    version: 1,
    operationId: capture.operationId,
    sessionId: capture.sessionId,
    composerRevision: capture.composerRevision,
    sequence,
    kind,
    ...payload,
  }) as DictationEvent;

describe('dictation transcript state', () => {
  it('replaces cumulative partials and accepts a final exactly once at the captured selection', () => {
    const initialState = createTranscriptState(capture);
    const firstPartial = applyDictationEvent(
      initialState,
      event(1, 'partial', { text: 'Please explain' }),
    );
    const secondPartial = applyDictationEvent(
      firstPartial.state,
      event(2, 'partial', { text: 'Please explain this concept' }),
    );

    expect(secondPartial.state.provisionalText).toBe(
      'Please explain this concept',
    );
    expect(secondPartial.acceptedFinal).toBeNull();

    const finalResult = applyDictationEvent(
      secondPartial.state,
      event(3, 'final', { text: 'Please explain this concept.' }),
    );
    expect(finalResult.acceptedFinal).toEqual({
      text: 'Please explain this concept.',
      composerRevision: 4,
      selection: { start: 3, end: 3 },
    });

    const repeatedFinal = applyDictationEvent(
      finalResult.state,
      event(4, 'final', { text: 'Please explain this concept.' }),
    );
    expect(repeatedFinal.acceptedFinal).toBeNull();
  });

  it('clears provisional text when the relay ends without speech', () => {
    const initialState = createTranscriptState(capture);
    const partial = applyDictationEvent(
      initialState,
      event(1, 'partial', { text: 'unintelligible noise' }),
    );
    const emptyFinal = applyDictationEvent(
      partial.state,
      event(2, 'final', { text: '  ' }),
    );

    expect(emptyFinal.state.status).toBe('empty');
    expect(emptyFinal.state.provisionalText).toBe('');
    expect(emptyFinal.acceptedFinal).toBeNull();
    expect(
      applyDictationEvent(
        emptyFinal.state,
        event(3, 'final', { text: 'late duplicate' }),
      ).acceptedFinal,
    ).toBeNull();

    const ended = applyDictationEvent(emptyFinal.state, event(3, 'ended'));
    expect(ended.state.provisionalText).toBe('');
  });

  it('discards late transcript events after cancellation', () => {
    const cancelledState = cancelTranscript(createTranscriptState(capture));
    const lateFinal = applyDictationEvent(
      cancelledState,
      event(1, 'final', { text: 'must not be inserted' }),
    );

    expect(lateFinal.state).toBe(cancelledState);
    expect(lateFinal.acceptedFinal).toBeNull();
  });
});
