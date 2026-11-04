import {
  AlertCircle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  CircleOff,
  Clock3,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Plug,
  RefreshCw,
} from 'lucide-react';
import type { AcademicDateSchema } from '@scholaros/services/ai/resources/shared';
import type { SourceKind } from '@scholaros/services/learning/context-contracts';
import type {
  AttentionItem,
  FreshnessStatus,
} from '@scholaros/services/learning/today-contracts';
import type {
  StudyActivity,
  StudySessionStatus,
} from '@scholaros/services/learning/study-contracts';
import { dateValueFrom } from '../../courses/lib/dates';
import {
  formatAcademicDateResolution,
  formatCourseDate,
} from '../../courses/lib/formatters';

export const formatTodayAttentionKind = (kind: AttentionItem['kind']) => {
  switch (kind) {
    case 'device':
      return { label: 'Device setup', Icon: Laptop };
    case 'connection':
      return { label: 'Connection', Icon: Plug };
    case 'sync':
      return { label: 'Course sync', Icon: RefreshCw };
    case 'context':
      return { label: 'Learning context', Icon: BookOpen };
    case 'permission':
      return { label: 'Access settings', Icon: LockKeyhole };
  }
};

export const formatTodayFreshness = (status: FreshnessStatus) => {
  switch (status) {
    case 'current':
      return { label: 'Up to date', Icon: CheckCircle2 };
    case 'stale':
      return { label: 'May need a refresh', Icon: Clock3 };
    case 'partial':
      return { label: 'Partly updated', Icon: AlertCircle };
    case 'unavailable':
      return { label: 'Not available yet', Icon: CircleOff };
  }
};

export const formatTodayCourseStatus = (active: boolean) =>
  active
    ? { label: 'Active class', Icon: CheckCircle2 }
    : { label: 'Inactive class', Icon: CircleOff };

export const formatStudyActivity = (activity: StudyActivity) => {
  switch (activity) {
    case 'understand-topic':
      return { label: 'Understand a topic', Icon: BookOpen };
    case 'prepare-exam':
      return { label: 'Prepare for exam', Icon: CalendarDays };
    case 'practice-knowledge':
      return { label: 'Practice what I know', Icon: CheckCircle2 };
    case 'review-graded-mistakes':
      return { label: 'Review graded work', Icon: AlertCircle };
    case 'assignment-start':
      return { label: 'Get started on an assignment', Icon: BookOpen };
  }
};

export const formatStudySessionStatus = (status: StudySessionStatus) => {
  switch (status) {
    case 'saved':
      return { label: 'Saved', Icon: BookOpen };
    case 'in-progress':
      return { label: 'In progress', Icon: LoaderCircle };
    case 'finished':
      return { label: 'Finished', Icon: CheckCircle2 };
    case 'interrupted':
      return { label: 'Interrupted', Icon: AlertCircle };
  }
};

export const formatTodayAcademicDate = (
  date: AcademicDateSchema | null,
  now = new Date().toISOString(),
) => {
  if (!date)
    return {
      label: 'No date observed',
      precisionLabel: 'The source did not provide a date.',
      Icon: CircleHelp,
      overdue: false,
    };
  const resolution = formatAcademicDateResolution(date);
  const label =
    formatCourseDate({
      dateValue: dateValueFrom(date),
      dateText: date.original,
      content: null,
    }) ?? date.original;
  return {
    label,
    precisionLabel: resolution.label,
    Icon: resolution.Icon,
    overdue:
      date.kind === 'instant' && Date.parse(date.instant) < Date.parse(now),
  };
};

export const formatTodayCollectionEmpty = (
  kind: 'assignments' | 'announcements' | 'materials',
) => {
  switch (kind) {
    case 'assignments':
      return 'No assignments were saved from your selected classes yet.';
    case 'announcements':
      return 'No announcements were saved from your selected classes yet.';
    case 'materials':
      return 'No course materials were saved from your selected classes yet.';
  }
};

export const formatTodayReadError = (offline: boolean) =>
  offline
    ? 'Saved information may be out of date. Connect again to refresh this overview.'
    : 'Today could not load. Try again to refresh your saved class information.';

export const formatTodayItemSource = (kind: SourceKind) => {
  switch (kind) {
    case 'course-material':
      return 'View course material';
    case 'context-version':
      return 'Open Context item';
    case 'assignment':
      return 'View assignment in course';
    case 'announcement':
      return 'View announcement in course';
    case 'saved-activity':
      return 'Open saved activity';
    case 'grade-evidence':
      return 'View grade evidence in course';
  }
};

export const formatTodayAnnouncementContent = (
  title: string,
  body: string | null,
) => {
  const heading = title.replace(/\s+/g, ' ').trim();
  const text = (body ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isPlaceholder =
    !heading || /^(?:announcements?|updates?)\s*:?$/i.test(heading);
  if (isPlaceholder && !text) return null;
  const label = isPlaceholder ? text.slice(0, 140) : heading;
  return {
    title: label,
    preview: text && text !== label ? text.slice(0, 500) : null,
  };
};
