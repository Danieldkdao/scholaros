import { CircleAlert } from 'lucide-react';
import { useId } from 'react';
import type { PracticeEvaluationDTO } from '@scholaros/services/learning/practice-contracts';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { cn } from '@scholaros/ui/lib/utils';
import { PracticeQuestion } from './practice-question';
import { usePracticeAttempt } from '../hooks/use-practice-attempt';
import {
  formatPracticeAssistance,
  formatPracticeAttemptHistory,
  formatPracticeFeedbackMode,
  formatPracticeMode,
  formatPracticeStatus,
} from '../lib/formatters';

type PracticeViewProps = {
  accountId: string;
  sessionId: string | null;
  attemptId: string;
  readOnly?: boolean;
  onAttemptChange?: (attemptId: string) => void;
};

export const PracticeView = ({
  accountId,
  sessionId,
  attemptId,
  onAttemptChange,
  readOnly = false,
}: PracticeViewProps) => {
  const titleId = `practice-title-${useId().replaceAll(':', '')}`;
  const practice = usePracticeAttempt({
    accountId,
    sessionId,
    attemptId,
    onAttemptChange,
    readOnly,
  });
  const snapshot = practice.snapshot;

  if (practice.isLoading) {
    return (
      <p
        aria-busy="true"
        aria-live="polite"
        className="text-muted-foreground"
        role="status"
      >
        Loading practice…
      </p>
    );
  }

  if (!snapshot) {
    return (
      <Card className="w-full" size="sm">
        <CardHeader>
          <CardTitle>Practice is unavailable</CardTitle>
          <CardDescription>
            {practice.loadError ?? 'This attempt could not be opened.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => void practice.reload()}
          >
            Try loading again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const status = formatPracticeStatus(snapshot.status);
  const assistance = formatPracticeAssistance(snapshot.assisted);
  const attemptHistory = formatPracticeAttemptHistory(snapshot.priorAttemptId);
  const feedbackMode = formatPracticeFeedbackMode(snapshot.feedbackMode);
  const showPerAnswerFeedback =
    snapshot.mode === 'quiz' &&
    snapshot.feedbackMode === 'per-answer' &&
    snapshot.status === 'in-progress';
  const showEndFeedback = snapshot.status === 'evaluated';
  const objectiveCount = new Set(
    snapshot.questions.flatMap((question) => question.objectiveIds),
  ).size;

  return (
    <section aria-labelledby={titleId} className="flex w-full flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-medium" id={titleId}>
              {formatPracticeMode(snapshot.mode)}
            </h2>
            {objectiveCount > 0 && (
              <p className="text-muted-foreground">
                Objectives: {objectiveCount}
              </p>
            )}
          </div>
          <p
            aria-live="polite"
            className="flex items-center gap-2 text-muted-foreground"
            role="status"
          >
            <status.Icon
              aria-hidden="true"
              className={cn(
                'size-5',
                snapshot.status === 'submitted' &&
                  'motion-safe:animate-spin motion-reduce:animate-none',
              )}
            />
            {status.label}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <TooltipWrapper content={assistance.tooltip}>
            <span
              className="flex w-fit items-center gap-2 rounded-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              tabIndex={0}
            >
              <assistance.Icon aria-hidden="true" className="size-4" />
              {assistance.label}
            </span>
          </TooltipWrapper>
          <TooltipWrapper content={attemptHistory.tooltip}>
            <span
              className="flex w-fit items-center gap-2 rounded-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              tabIndex={0}
            >
              <attemptHistory.Icon aria-hidden="true" className="size-4" />
              {attemptHistory.label}
            </span>
          </TooltipWrapper>
          {snapshot.mode === 'quiz' && (
            <span
              aria-label={feedbackMode.description}
              className="text-muted-foreground"
            >
              {feedbackMode.label}
            </span>
          )}
        </div>
      </header>

      {readOnly && (
        <p className="text-base text-muted-foreground" role="status">
          Reconnect online to save pending answers, change practice mode, or
          submit this attempt.
        </p>
      )}

      {practice.actionError && (
        <p className="flex items-start gap-2 text-destructive" role="alert">
          <CircleAlert aria-hidden="true" className="mt-1 size-5 shrink-0" />
          {practice.actionError}
        </p>
      )}

      {snapshot.mode === 'guided' && snapshot.assisted && (
        <p
          className="rounded-md border border-border bg-muted/40 p-3"
          role="status"
        >
          Guided practice is on. This attempt is marked assisted and is not
          independent evidence.
        </p>
      )}
      {practice.isSwitchingToGuided && (
        <p aria-live="polite" className="text-muted-foreground" role="status">
          Switching to guided practice. This attempt will be marked assisted
          before guidance appears.
        </p>
      )}
      {practice.isSubmitting && (
        <p aria-live="polite" className="text-muted-foreground" role="status">
          Saving your answers before submission.
        </p>
      )}
      {practice.isRetrying && (
        <p aria-live="polite" className="text-muted-foreground" role="status">
          Starting another practice attempt.
        </p>
      )}
      {snapshot.status === 'submitted' && (
        <p aria-live="polite" className="text-muted-foreground" role="status">
          Your saved answers are being evaluated. Feedback will appear when the
          evaluation finishes.
        </p>
      )}
      {snapshot.status === 'interrupted' && (
        <p className="text-muted-foreground" role="status">
          Evaluation did not finish. Your saved answers are still here.
        </p>
      )}

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void practice.submit();
        }}
      >
        {snapshot.questions.map((question, index) => {
          const feedback: PracticeEvaluationDTO | null =
            showEndFeedback || showPerAnswerFeedback
              ? (snapshot.feedback.find(
                  (item) => item.questionId === question.id,
                ) ?? null)
              : null;

          return (
            <PracticeQuestion
              key={question.id}
              question={question}
              questionNumber={index + 1}
              value={practice.answerDrafts[question.id] ?? ''}
              onChange={(value) => practice.changeAnswer(question.id, value)}
              onRetrySave={() => practice.retryAnswerSave(question.id)}
              answerState={practice.answerSaveStates[question.id] ?? 'empty'}
              error={practice.answerErrors[question.id] ?? null}
              disabled={
                readOnly ||
                snapshot.status !== 'in-progress' ||
                practice.isSubmitting ||
                practice.isSwitchingToGuided
              }
              feedback={feedback}
            />
          );
        })}

        {snapshot.status === 'in-progress' && (
          <div className="flex flex-wrap items-center gap-3">
            {snapshot.mode !== 'guided' && (
              <Button
                type="button"
                variant="outline"
                disabled={
                  readOnly ||
                  practice.isSubmitting ||
                  practice.isSwitchingToGuided
                }
                aria-busy={practice.isSwitchingToGuided}
                aria-label={
                  practice.isSwitchingToGuided
                    ? 'Switching to guided practice'
                    : undefined
                }
                onClick={() => void practice.switchToGuided()}
              >
                <LoadingSwap isLoading={practice.isSwitchingToGuided}>
                  Switch to guided practice
                </LoadingSwap>
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                readOnly ||
                practice.isSubmitting ||
                practice.isSwitchingToGuided
              }
              aria-busy={practice.isSubmitting}
              aria-label={
                practice.isSubmitting ? 'Submitting answers' : undefined
              }
            >
              <LoadingSwap isLoading={practice.isSubmitting}>
                Submit answers
              </LoadingSwap>
            </Button>
          </div>
        )}
        {(snapshot.status === 'evaluated' ||
          snapshot.status === 'interrupted') && (
          <div className="flex flex-col gap-2">
            {snapshot.status === 'interrupted' && (
              <p className="text-muted-foreground">
                A new attempt keeps this one and its saved responses as history.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={readOnly || practice.isRetrying}
              onClick={() => void practice.retry()}
              aria-busy={practice.isRetrying}
              aria-label={
                practice.isRetrying ? 'Starting another attempt' : undefined
              }
            >
              <LoadingSwap isLoading={practice.isRetrying}>
                Try again
              </LoadingSwap>
            </Button>
          </div>
        )}
      </form>
    </section>
  );
};
