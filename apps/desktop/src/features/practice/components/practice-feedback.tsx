import { BookOpenText } from 'lucide-react';
import type { PracticeEvaluationDTO } from '@scholaros/services/learning/practice-contracts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { cn } from '@scholaros/ui/lib/utils';
import {
  formatPracticeLocator,
  formatPracticeOutcome,
  formatPracticeSourceState,
} from '../lib/formatters';

type PracticeFeedbackProps = {
  feedback: PracticeEvaluationDTO;
};

export const PracticeFeedback = ({ feedback }: PracticeFeedbackProps) => {
  const outcome = formatPracticeOutcome(feedback.outcome);

  return (
    <Card
      aria-label="Answer feedback"
      className="border-border bg-muted/40 shadow-none"
      role="group"
      size="sm"
    >
      <CardHeader>
        <CardTitle className={cn('flex items-center gap-2', outcome.className)}>
          <outcome.Icon aria-hidden="true" className="size-5" />
          {outcome.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p>{feedback.explanation}</p>
        {feedback.acceptedAlternatives.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="font-medium">Also accepted</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {feedback.acceptedAlternatives.map((alternative, index) => (
                <li key={`${alternative}:${index}`}>{alternative}</li>
              ))}
            </ul>
          </div>
        )}
        {feedback.sourceReferences.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="font-medium">Sources</p>
            <ul className="flex flex-col gap-2">
              {feedback.sourceReferences.map((source) => {
                const sourceState = formatPracticeSourceState(source.state);
                const locator = formatPracticeLocator(source.locator);
                const sourceKey = [
                  source.sourceKind,
                  source.sourceId,
                  source.versionId ?? '',
                  locator ?? '',
                ].join(':');

                return (
                  <li
                    key={sourceKey}
                    className="flex flex-wrap items-center gap-2 text-muted-foreground"
                  >
                    <BookOpenText aria-hidden="true" className="size-4" />
                    <span className="text-foreground">{source.title}</span>
                    {locator && <span>{locator}</span>}
                    <span className="flex items-center gap-1">
                      <sourceState.Icon aria-hidden="true" className="size-4" />
                      {sourceState.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
