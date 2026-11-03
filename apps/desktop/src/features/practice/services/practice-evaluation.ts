import {
  practiceEvaluationSchema,
  type PracticeEvaluationDTO,
  type PracticeQuestionDTO,
} from '@scholaros/services/learning/practice-contracts';
import {
  idSchema,
  type JsonValue,
} from '@scholaros/services/learning/product-contracts';

export type PracticeEvaluationValidationInput = {
  question: PracticeQuestionDTO;
  answerKey: JsonValue;
  rubricVersion: string;
  assisted: boolean;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
};

const answerKeyForQuestion = (
  answerKey: JsonValue,
  question: PracticeQuestionDTO,
) => {
  if (!Array.isArray(answerKey)) return null;
  const matches = answerKey.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.questionId === question.id,
  );
  if (matches.length !== 1) return null;
  const entry = matches[0];
  if (
    typeof entry !== 'object' ||
    entry === null ||
    Array.isArray(entry) ||
    entry.kind !== question.kind ||
    !Array.isArray(entry.acceptedAlternatives) ||
    entry.acceptedAlternatives.some((value) => typeof value !== 'string')
  )
    return null;
  if (question.kind === 'multiple-choice') {
    if (
      typeof entry.correctOptionId !== 'string' ||
      !question.options?.some(({ id }) => id === entry.correctOptionId)
    )
      return null;
  } else if (question.kind === 'numeric') {
    if (
      !Array.isArray(entry.acceptedValues) ||
      entry.acceptedValues.length === 0
    )
      return null;
  } else if (
    !Array.isArray(entry.rubricCriteria) ||
    entry.rubricCriteria.length === 0 ||
    entry.rubricCriteria.some((value) => typeof value !== 'string')
  ) {
    return null;
  }
  return entry;
};

export const validatePracticeEvaluation = (
  input: PracticeEvaluationValidationInput,
  evaluation: unknown,
): PracticeEvaluationDTO | null => {
  const parsedEvaluation = practiceEvaluationSchema.safeParse(evaluation);
  const parsedRubricVersion = idSchema.safeParse(input.rubricVersion);
  if (
    !parsedEvaluation.success ||
    !parsedRubricVersion.success ||
    parsedEvaluation.data.questionId !== input.question.id ||
    parsedEvaluation.data.rubricVersion !== input.rubricVersion ||
    parsedEvaluation.data.assisted !== input.assisted ||
    stableJson(parsedEvaluation.data.sourceReferences) !==
      stableJson(input.question.sourceReferences)
  )
    return null;

  const answerKey = answerKeyForQuestion(input.answerKey, input.question);
  if (!answerKey) return null;
  const allowedAlternatives = new Set(
    answerKey.acceptedAlternatives as string[],
  );
  if (
    parsedEvaluation.data.acceptedAlternatives.some(
      (alternative) => !allowedAlternatives.has(alternative),
    )
  )
    return null;
  return parsedEvaluation.data;
};
