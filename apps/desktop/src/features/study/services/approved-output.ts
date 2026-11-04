import type {
  AuthorizedContext,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import type { StudyMessageDTO } from '@scholaros/services/learning/study-contracts';

/** Delivers only an authoritative, already committed tutor message. */
export const publishApprovedTutorOutput = (
  context: AuthorizedContext,
  input: {
    sessionId: string;
    generationEpoch: number;
    revision: number;
    message: StudyMessageDTO;
  },
  publish: (event: ProductEventV1) => void,
  isStillAuthorized: () => boolean = () => true,
) => {
  const { message } = input;
  if (
    message.sessionId !== input.sessionId ||
    message.role !== 'tutor' ||
    message.status !== 'accepted' ||
    !message.turnId
  )
    return;
  let sequence = 0;
  let lastPartIndex = 0;
  const send = (partIndex: number, textDelta: string, done: boolean) => {
    if (context.signal.aborted || !context.isCurrent() || !isStillAuthorized())
      return false;
    const event = productEventV1Schema.parse({
      version: 1,
      accountId: context.userId,
      resource: 'study',
      targetId: input.sessionId,
      revision: input.revision,
      approvedTutorOutput: {
        turnId: message.turnId,
        generationEpoch: input.generationEpoch,
        messageId: message.id,
        messageSequence: message.sequence,
        createdAt: message.createdAt,
        gradeDerived: message.gradeDerived,
        gradeConsentRevision: message.gradeConsentRevision,
        partIndex,
        sequence: sequence++,
        textDelta,
        done,
      },
    });
    try {
      publish(event);
    } catch {
      return false;
    }
    return true;
  };
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.kind !== 'text') continue;
    lastPartIndex = partIndex;
    // Bound transport frames without a timer or simulated typing delay. Split
    // by code point so an emoji is never delivered as an invalid surrogate.
    const characters = Array.from(part.text);
    for (let offset = 0; offset < characters.length; offset += 2048) {
      if (
        !send(
          partIndex,
          characters.slice(offset, offset + 2048).join(''),
          false,
        )
      )
        return;
    }
  }
  send(lastPartIndex, '', true);
};
