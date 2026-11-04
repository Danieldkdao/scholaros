import type { GradeSettings } from '@scholaros/services/learning/grade-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import type {
  SessionSnapshot,
  StudyMessageDTO,
} from '@scholaros/services/learning/study-contracts';

type ApprovedOutput = NonNullable<ProductEventV1['approvedTutorOutput']>;
export type ApprovedTutorPreview = {
  scope: string;
  revision: number;
  output: ApprovedOutput;
  textParts: Map<number, string>;
};

export const isApprovedPreviewCurrent = (
  preview: ApprovedTutorPreview,
  scope: string,
  snapshot: SessionSnapshot,
  grades: GradeSettings | null,
) =>
  preview.scope === scope &&
  preview.output.generationEpoch === snapshot.session.generationEpoch &&
  preview.revision >= snapshot.revision &&
  !snapshot.messages.some(
    (message) => message.id === preview.output.messageId,
  ) &&
  (!preview.output.gradeDerived ||
    (grades?.enabled === true &&
      grades.revision === preview.output.gradeConsentRevision));

export const receiveApprovedTutorOutput = (
  previous: ApprovedTutorPreview | null,
  event: ProductEventV1,
  scope: string,
  snapshot: SessionSnapshot,
  grades: GradeSettings | null,
): ApprovedTutorPreview | null => {
  const output = event.approvedTutorOutput;
  if (!output) return previous;
  const sameMessage =
    previous?.scope === scope && previous.output.messageId === output.messageId;
  // Missing/replayed chunks cannot produce a truncated or duplicated preview.
  if (output.sequence !== (sameMessage ? previous.output.sequence + 1 : 0))
    return previous;
  if (
    sameMessage &&
    (previous.output.done ||
      previous.revision !== event.revision ||
      previous.output.turnId !== output.turnId ||
      previous.output.generationEpoch !== output.generationEpoch ||
      previous.output.gradeDerived !== output.gradeDerived ||
      previous.output.gradeConsentRevision !== output.gradeConsentRevision ||
      previous.output.messageSequence !== output.messageSequence ||
      previous.output.createdAt !== output.createdAt ||
      output.partIndex < previous.output.partIndex)
  )
    return previous;
  if (
    !sameMessage &&
    previous?.scope === scope &&
    event.revision <= previous.revision
  )
    return previous;
  const textParts = new Map(sameMessage ? previous.textParts : []);
  if (output.textDelta) {
    const text = (textParts.get(output.partIndex) ?? '') + output.textDelta;
    if (text.length > 32_000) return previous;
    textParts.set(output.partIndex, text);
  }
  const preview = { scope, revision: event.revision, output, textParts };
  return isApprovedPreviewCurrent(preview, scope, snapshot, grades)
    ? preview
    : previous;
};

export const approvedPreviewMessage = (
  preview: ApprovedTutorPreview,
  sessionId: string,
): StudyMessageDTO => ({
  id: preview.output.messageId,
  sessionId,
  turnId: preview.output.turnId,
  sequence: preview.output.messageSequence,
  role: 'tutor',
  status: 'accepted',
  createdAt: preview.output.createdAt,
  gradeDerived: preview.output.gradeDerived,
  gradeConsentRevision: preview.output.gradeConsentRevision,
  parts: [...preview.textParts]
    .sort(([first], [second]) => first - second)
    .map(([, text]) => ({ kind: 'text', text })),
});
