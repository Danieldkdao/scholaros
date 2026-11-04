import {
  BookOpenCheck,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  HandHelping,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import type {
  PracticeEvaluationOutcome,
  PracticeFeedbackMode,
  PracticeMode,
  PracticeStatus,
} from '@scholaros/services/learning/practice-contracts';
import type {
  Locator,
  SourceReference,
} from '@scholaros/services/learning/context-contracts';

export type PracticeAnswerSaveState = 'empty' | 'saved' | 'saving' | 'error';

export const formatPracticeStatus = (status: PracticeStatus) => {
  switch (status) {
    case 'in-progress':
      return { label: 'In progress', Icon: CircleDashed };
    case 'submitted':
      return { label: 'Evaluating answers', Icon: Loader2 };
    case 'evaluated':
      return { label: 'Feedback ready', Icon: CircleCheck };
    case 'interrupted':
      return { label: 'Evaluation stopped', Icon: CircleAlert };
  }
};

export const formatPracticeMode = (mode: PracticeMode) => {
  switch (mode) {
    case 'quiz':
      return 'Quiz';
    case 'exam':
      return 'Practice exam';
    case 'guided':
      return 'Guided practice';
  }
};

export const formatPracticeFeedbackMode = (mode: PracticeFeedbackMode) => {
  switch (mode) {
    case 'end':
      return {
        label: 'Feedback at the end',
        description: 'Your answers are reviewed after you submit.',
      };
    case 'per-answer':
      return {
        label: 'Answer-by-answer feedback',
        description: 'Feedback appears as each answer is saved.',
      };
  }
};

export const formatPracticeOutcome = (outcome: PracticeEvaluationOutcome) => {
  switch (outcome) {
    case 'correct':
      return {
        label: 'Correct',
        className: 'text-primary',
        Icon: CircleCheck,
      };
    case 'incorrect':
      return {
        label: 'Review this answer',
        className: 'text-destructive',
        Icon: CircleX,
      };
    case 'uncertain':
      return {
        label: 'Could not assess confidently',
        className: 'text-muted-foreground',
        Icon: CircleHelp,
      };
  }
};

export const formatPracticeAnswerSaveState = (
  state: PracticeAnswerSaveState,
) => {
  switch (state) {
    case 'empty':
      return { label: 'Not answered yet', Icon: CircleDashed };
    case 'saved':
      return { label: 'Answer saved', Icon: CircleCheck };
    case 'saving':
      return { label: 'Saving answer', Icon: Loader2 };
    case 'error':
      return { label: 'Could not save answer', Icon: CircleAlert };
  }
};

export const formatPracticeAssistance = (assisted: boolean) => {
  switch (assisted) {
    case false:
      return {
        label: 'Independent practice',
        tooltip: 'This attempt has not been marked as assisted.',
        Icon: BookOpenCheck,
      };
    case true:
      return {
        label: 'Assisted practice',
        tooltip:
          'This attempt includes guidance and is not independent evidence.',
        Icon: HandHelping,
      };
  }
};

export const formatPracticeAttemptHistory = (priorAttemptId: string | null) => {
  switch (priorAttemptId === null) {
    case true:
      return {
        label: 'First attempt',
        tooltip: 'No earlier attempt is linked to this practice.',
        Icon: BookOpenCheck,
      };
    case false:
      return {
        label: 'Repeated practice',
        tooltip: 'An earlier attempt is preserved separately.',
        Icon: RotateCcw,
      };
  }
};

export const formatPracticeSourceState = (state: SourceReference['state']) => {
  switch (state) {
    case 'current':
      return { label: 'Current source', Icon: BookOpenCheck };
    case 'historical':
      return { label: 'Historical source', Icon: RotateCcw };
    case 'removed':
      return { label: 'Source removed', Icon: CircleAlert };
    case 'unavailable':
      return { label: 'Source unavailable', Icon: CircleHelp };
  }
};

export const formatPracticeLocator = (locator: Locator | null) => {
  if (!locator) return null;
  switch (locator.kind) {
    case 'page':
      return `Page ${locator.page}`;
    case 'heading':
      return `Heading: ${locator.heading}`;
    case 'paragraph':
      return `Paragraph ${locator.ordinal}`;
  }
};
