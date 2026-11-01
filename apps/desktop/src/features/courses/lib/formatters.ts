import {
  Check as RefreshCheck,
  CircleAlert as RefreshAlert,
  Loader2 as RefreshLoader,
  Square as RefreshStop,
} from 'lucide-react';
import type { CourseRefreshActivity } from '../types';
import { format, intlFormat, isValid, parseISO } from 'date-fns';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleOff,
  CircleStop,
  KeyRound,
  Plug,
  CalendarDays,
  CalendarClock,
  CircleHelp,
  Clock,
} from 'lucide-react';
import { academicDateFor } from './dates';
import type {
  ResourceKind,
  AcademicDateSchema,
} from '@scholaros/services/ai/resources/shared';
import type { CourseChildItem } from '../types';
import type {
  CoursesSnapshot,
  CourseScanStatus,
  CourseSourceState,
} from '../types';

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

// A date-only value has no time to show, so it is read and formatted in UTC to
// keep the day the source named rather than the viewer's local one.
const instantOf = (dateValue: string) =>
  Date.parse(
    dateOnlyPattern.test(dateValue) ? `${dateValue}T12:00:00Z` : dateValue,
  );

const isDateOnly = (dateValue: string) => dateOnlyPattern.test(dateValue);

export const formatCourseRecordKind = (kind: ResourceKind) => {
  switch (kind) {
    case 'courses':
      return 'course';
    case 'assignments':
      return 'assignment';
    case 'announcements':
      return 'announcement';
  }
};

export const formatCourseScanStatus = (status: CourseScanStatus) => {
  switch (status) {
    case 'pending':
      return { label: 'Not fetched yet', Icon: CircleDashed };
    case 'complete':
      return { label: 'Up to date', Icon: CircleCheck };
    case 'partial':
      return { label: 'Partly read', Icon: CircleAlert };
    case 'needs-sign-in':
      return { label: 'Needs sign-in', Icon: KeyRound };
    case 'blocked':
      return { label: 'Not found', Icon: Ban };
    case 'cancelled':
      return { label: 'Refresh stopped', Icon: CircleStop };
  }
};

export const formatCourseSourceState = (state: CourseSourceState) => {
  switch (state) {
    case 'manual':
      return { label: 'Added manually', Icon: CircleCheck };
    case 'connected':
      return { label: 'Connected', Icon: Plug };
    case 'unmarked':
      return { label: 'No longer selected', Icon: CircleOff };
    case 'removed':
      return { label: 'Source removed', Icon: Ban };
  }
};

export const formatAcademicDateResolution = (
  date: AcademicDateSchema | null,
) => {
  if (!date) return { label: 'No date observed', Icon: CircleDashed };
  switch (date.kind) {
    case 'instant':
      return {
        label: date.timezone ?? 'Explicit timezone offset',
        Icon: Clock,
      };
    case 'date':
      return {
        label: 'Date only; no deadline time was specified',
        Icon: CalendarDays,
      };
    case 'local':
      return {
        label: 'Local time; the source timezone is not established',
        Icon: CalendarClock,
      };
    case 'unresolved':
      return { label: date.reason, Icon: CircleHelp };
  }
};

export const formatCourseDate = (
  item: Pick<CourseChildItem, 'dateValue' | 'dateText' | 'content'>,
) => {
  const date = academicDateFor(item);
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date.original)) {
    const parsed = parseISO(date.original);
    if (isValid(parsed))
      return format(
        parsed,
        date.original.includes('T') ? 'MMM d, yyyy, h:mm a' : 'MMM d, yyyy',
      );
  }
  if (item.content || date.kind === 'local' || date.kind === 'unresolved')
    return date.original;
  const value = date.kind === 'instant' ? date.instant : date.date;
  return intlFormat(
    new Date(instantOf(value)),
    date.kind === 'date'
      ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
      : {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        },
  );
};

// A day without a time is not over until it ends, so it counts as past only
// once the whole day has gone.
export const isPastDate = (dateValue: string | null, now: string) => {
  if (!dateValue) return false;
  if (isDateOnly(dateValue)) {
    const nextDay = new Date(`${dateValue}T00:00:00`);
    nextDay.setDate(nextDay.getDate() + 1);
    return nextDay.getTime() <= Date.parse(now);
  }
  const instant = Date.parse(dateValue);
  return !Number.isNaN(instant) && instant < Date.parse(now);
};

const displayDayOf = (instant: string) => format(instant, 'yyyy-MM-dd');

const dateGroup = (date: AcademicDateSchema | null) => {
  if (!date) return 2;
  switch (date.kind) {
    case 'instant':
    case 'date':
      return 0;
    case 'local':
      return 1;
    case 'unresolved':
      return 2;
  }
};

// Mixing precisions uses the viewer's display day; date-only items precede timed items on that day.
const byDate =
  (direction: 1 | -1) =>
  <TItem extends Pick<CourseChildItem, 'dateValue'> & Partial<CourseChildItem>>(
    items: TItem[],
  ) =>
    [...items].sort((left, right) => {
      const first = academicDateFor({
        ...left,
        dateText: left.dateText ?? null,
      });
      const second = academicDateFor({
        ...right,
        dateText: right.dateText ?? null,
      });
      const group = dateGroup(first) - dateGroup(second);
      if (group) return group;
      if (
        !first ||
        !second ||
        first.kind === 'unresolved' ||
        second.kind === 'unresolved'
      )
        return 0;
      if (first.kind === 'local' || second.kind === 'local') {
        if (first.kind !== 'local' || second.kind !== 'local') return 0;
        return (
          direction *
          `${first.date}T${first.time}`.localeCompare(
            `${second.date}T${second.time}`,
          )
        );
      }
      if (first.kind === 'instant' && second.kind === 'instant')
        return (
          direction * (Date.parse(first.instant) - Date.parse(second.instant))
        );
      const firstDay =
        first.kind === 'date' ? first.date : displayDayOf(first.instant);
      const secondDay =
        second.kind === 'date' ? second.date : displayDayOf(second.instant);
      const day = direction * firstDay.localeCompare(secondDay);
      if (day) return day;
      return first.kind === second.kind ? 0 : first.kind === 'date' ? -1 : 1;
    });

export const sortAnnouncements = byDate(-1);
export const sortAssignments = byDate(1);

// Keep saved courses when a refresh finds no replacement results.
export const formatCoursesEmpty = (snapshot: CoursesSnapshot | null) => {
  if (!snapshot || !snapshot.sources.length) return 'No courses saved yet.';
  return snapshot.sources.every((source) => source.outcome === 'complete')
    ? 'Your selected course sources were read and listed no courses.'
    : 'Courses were not found in your selected sources; your saved courses are unchanged.';
};

// One wording per combination so a tab never claims data it does not have.
export const formatCollectionState = (
  kind: 'announcements' | 'assignments',
  status: CourseScanStatus,
  count: number,
) => {
  if (count > 0)
    return status === 'complete'
      ? null
      : `Saved ${kind} may be incomplete or out of date.`;
  switch (status) {
    case 'pending':
      return `No ${kind} have been read yet.`;
    case 'complete':
    case 'blocked':
      return `No ${kind} found for this course.`;
    case 'partial':
      return `Only part of this list could be read, and it showed no ${kind}.`;
    case 'needs-sign-in':
      return `Sign in to this resource to read its ${kind}.`;
    case 'cancelled':
      return `The refresh stopped before these ${kind} were read.`;
  }
};

export const formatRefreshActivity = (
  status: CourseRefreshActivity['status'],
) => {
  switch (status) {
    case 'running':
      return { label: 'Refreshing courses…', Icon: RefreshLoader };
    case 'complete':
      return { label: 'Refresh complete', Icon: RefreshCheck };
    case 'partial':
      return {
        label: 'Refresh needs attention',
        Icon: RefreshAlert,
      };
    case 'cancelled':
      return { label: 'Refresh stopped', Icon: RefreshStop };
    case 'failed':
      return { label: 'Refresh failed', Icon: RefreshAlert };
  }
};
