import { describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { StudyMessageDTO } from '@scholaros/services/learning/study-contracts';
import { publishApprovedTutorOutput } from '../services/approved-output';

const message: StudyMessageDTO = {
  id: 'message-1',
  sessionId: 'session-1',
  sequence: 2,
  role: 'tutor',
  turnId: 'turn-1',
  createdAt: '2026-11-04T12:00:00.000Z',
  parts: [
    { kind: 'text', text: 'Approved explanation. ' + '😀'.repeat(3000) },
    { kind: 'activity', artifactId: 'a', versionId: 'v', attemptId: 'attempt' },
  ],
  status: 'accepted',
  gradeDerived: false,
  gradeConsentRevision: null,
};
const context = (signal = new AbortController().signal): AuthorizedContext => ({
  userId: 'student-1',
  epoch: 1,
  isCurrent: () => true,
  signal,
});
const input = {
  sessionId: 'session-1',
  generationEpoch: 4,
  revision: 7,
  message,
};

describe('committed tutor output delivery', () => {
  it('delivers bounded ordered text frames and completion without corrupting unicode or activity parts', () => {
    const events: ProductEventV1[] = [];
    publishApprovedTutorOutput(context(), input, (event) => events.push(event));
    expect(events.length).toBeGreaterThan(2);
    expect(
      events.map(({ approvedTutorOutput }) => approvedTutorOutput?.sequence),
    ).toEqual(events.map((_, index) => index));
    expect(events.at(-1)?.approvedTutorOutput).toMatchObject({
      done: true,
      textDelta: '',
    });
    expect(
      events
        .map(({ approvedTutorOutput }) => approvedTutorOutput?.textDelta)
        .join(''),
    ).toBe(message.parts[0]!.kind === 'text' ? message.parts[0]!.text : '');
    expect(
      events.every(
        (event) =>
          event.accountId === 'student-1' &&
          event.targetId === 'session-1' &&
          event.revision === 7 &&
          event.approvedTutorOutput?.generationEpoch === 4,
      ),
    ).toBe(true);
    expect(message.parts[1]).toEqual({
      kind: 'activity',
      artifactId: 'a',
      versionId: 'v',
      attemptId: 'attempt',
    });
  });

  it('publishes nothing for another session, an unaccepted message, or a cancelled account', () => {
    const publish = vi.fn();
    publishApprovedTutorOutput(
      context(),
      { ...input, sessionId: 'other' },
      publish,
    );
    publishApprovedTutorOutput(
      context(),
      { ...input, message: { ...message, status: 'failed' } },
      publish,
    );
    const controller = new AbortController();
    controller.abort();
    publishApprovedTutorOutput(context(controller.signal), input, publish);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops before publishing another frame if grade consent or the stored generation is revoked', () => {
    let allowed = true;
    const events: ProductEventV1[] = [];
    publishApprovedTutorOutput(
      context(),
      {
        ...input,
        message: { ...message, gradeDerived: true, gradeConsentRevision: 2 },
      },
      (event) => {
        events.push(event);
        allowed = false;
      },
      () => allowed,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.approvedTutorOutput?.done).toBe(false);
  });

  it('stops delivery immediately when the account becomes stale or a subscriber fails', () => {
    let current = true;
    const publish = vi.fn(() => {
      current = false;
    });
    publishApprovedTutorOutput(
      { ...context(), isCurrent: () => current },
      input,
      publish,
    );
    expect(publish).toHaveBeenCalledOnce();
    const unavailable = vi.fn(() => {
      throw new Error('subscriber stopped');
    });
    expect(() =>
      publishApprovedTutorOutput(context(), input, unavailable),
    ).not.toThrow();
    expect(unavailable).toHaveBeenCalledOnce();
  });
});
