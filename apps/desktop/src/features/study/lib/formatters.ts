import { format, isValid, parseISO } from 'date-fns';
import {
  BookOpen,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  Clock3,
  ClipboardList,
  RotateCcw,
} from 'lucide-react';
import type {
  StudyActivity,
  StudySessionStatus,
} from '@scholaros/services/learning/study-contracts';

export const formatStudyActivity = (activity: StudyActivity) => {
  switch (activity) {
    case 'understand-topic':
      return { label: 'Understand a topic', Icon: BookOpen };
    case 'prepare-exam':
      return { label: 'Prepare for an exam', Icon: CalendarDays };
    case 'practice-knowledge':
      return { label: 'Practice what I know', Icon: RotateCcw };
    case 'review-graded-mistakes':
      return { label: 'Review graded mistakes', Icon: CircleCheck };
    case 'assignment-start':
      return {
        label: 'Help me get started on an assignment',
        Icon: ClipboardList,
      };
    default: {
      const exhaustive: never = activity;
      return exhaustive;
    }
  }
};

export const formatStudySessionStatus = (status: StudySessionStatus) => {
  switch (status) {
    case 'saved':
      return { label: 'Saved', Icon: BookOpen };
    case 'in-progress':
      return { label: 'In progress', Icon: Clock3 };
    case 'finished':
      return { label: 'Finished', Icon: CircleCheck };
    case 'interrupted':
      return { label: 'Interrupted', Icon: CircleAlert };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const formatStudyUpdatedAt = (updatedAt: string) => {
  const parsed = parseISO(updatedAt);
  return isValid(parsed) ? format(parsed, 'PPp') : 'Update time unavailable';
};
