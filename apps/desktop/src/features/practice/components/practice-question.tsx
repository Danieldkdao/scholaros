import { useId } from 'react';
import type {
  PracticeEvaluationDTO,
  PracticeQuestionDTO,
} from '@scholaros/services/learning/practice-contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Button } from '@scholaros/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@scholaros/ui/components/field';
import { Input } from '@scholaros/ui/components/input';
import {
  RadioGroup,
  RadioGroupItem,
} from '@scholaros/ui/components/radio-group';
import { Textarea } from '@scholaros/ui/components/textarea';
import { cn } from '@scholaros/ui/lib/utils';
import type { PracticeAnswerSaveState } from '../lib/formatters';
import { formatPracticeAnswerSaveState } from '../lib/formatters';
import { PracticeFeedback } from './practice-feedback';

type PracticeQuestionProps = {
  question: PracticeQuestionDTO;
  questionNumber: number;
  value: string;
  onChange: (value: string) => void;
  onRetrySave: () => void;
  answerState: PracticeAnswerSaveState;
  error: string | null;
  disabled: boolean;
  feedback: PracticeEvaluationDTO | null;
};

export const PracticeQuestion = ({
  question,
  questionNumber,
  value,
  onChange,
  onRetrySave,
  answerState,
  error,
  disabled,
  feedback,
}: PracticeQuestionProps) => {
  const instanceId = useId().replaceAll(':', '');
  const answerId = `practice-answer-${instanceId}-${questionNumber}`;
  const answerLabelId = `${answerId}-label`;
  const answerDescriptionId = `${answerId}-description`;
  const answerErrorId = `${answerId}-error`;
  const describedBy = error
    ? `${answerDescriptionId} ${answerErrorId}`
    : answerDescriptionId;
  const saveStatus = formatPracticeAnswerSaveState(answerState);

  return (
    <Card
      aria-labelledby={`${answerId}-title`}
      className="w-full"
      role="group"
      size="sm"
    >
      <CardHeader>
        <CardTitle id={`${answerId}-title`}>
          Question {questionNumber}
        </CardTitle>
        <CardDescription>{question.prompt}</CardDescription>
      </CardHeader>
      <CardContent>
        {question.kind === 'multiple-choice' ? (
          <FieldSet disabled={disabled} className="gap-3">
            <FieldLegend id={answerLabelId} variant="label">
              Your answer
            </FieldLegend>
            {question.options ? (
              <RadioGroup
                aria-labelledby={answerLabelId}
                aria-describedby={describedBy}
                aria-invalid={error ? true : undefined}
                value={value || null}
                onValueChange={(nextValue) => {
                  if (nextValue !== null) onChange(nextValue);
                }}
              >
                {question.options.map((option, index) => {
                  return (
                    <FieldLabel
                      key={`${option.id}:${index}`}
                      className={cn(
                        'flex w-full flex-row items-center gap-3 rounded-md border border-border p-3 text-base',
                        disabled && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <RadioGroupItem
                        value={option.id}
                        aria-describedby={describedBy}
                        disabled={disabled}
                      />
                      <span>{option.text}</span>
                    </FieldLabel>
                  );
                })}
              </RadioGroup>
            ) : (
              <FieldDescription>
                Answer choices are unavailable for this question.
              </FieldDescription>
            )}
            <FieldError id={answerErrorId}>{error}</FieldError>
          </FieldSet>
        ) : (
          <Field>
            <FieldLabel htmlFor={answerId}>Your answer</FieldLabel>
            {question.kind === 'numeric' ? (
              <Input
                id={answerId}
                type="text"
                inputMode="decimal"
                aria-label={`Answer for question ${questionNumber}`}
                aria-describedby={describedBy}
                aria-invalid={error ? true : undefined}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.value)}
              />
            ) : (
              <Textarea
                id={answerId}
                aria-label={`Answer for question ${questionNumber}`}
                aria-describedby={describedBy}
                aria-invalid={error ? true : undefined}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.value)}
              />
            )}
            <FieldDescription id={answerDescriptionId}>
              {question.kind === 'numeric'
                ? question.unit
                  ? `Include a numeric value in ${question.unit}.`
                  : 'Enter a numeric value.'
                : 'Explain your thinking in a few sentences.'}
            </FieldDescription>
            <FieldError id={answerErrorId}>{error}</FieldError>
          </Field>
        )}
        {error && !disabled && (
          <Button type="button" variant="outline" onClick={onRetrySave}>
            Retry save
          </Button>
        )}
        <p
          aria-live="polite"
          className="flex items-center gap-2 text-muted-foreground"
          role="status"
        >
          <saveStatus.Icon aria-hidden="true" className="size-4" />
          {saveStatus.label}
        </p>
        {feedback && <PracticeFeedback feedback={feedback} />}
      </CardContent>
    </Card>
  );
};
