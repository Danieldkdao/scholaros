import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleOff,
  CircleStop,
  KeyRound,
  Plug,
} from "lucide-react";
import { storedDateFrom } from "./dates";
import type {
  CoursesSnapshot,
  CourseScanStatus,
  CourseSourceState,
} from "../types";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

// A date-only value has no time to show, so it is read and formatted in UTC to
// keep the day the source named rather than the viewer's local one.
const instantOf = (dateValue: string) =>
  Date.parse(
    dateOnlyPattern.test(dateValue) ? `${dateValue}T12:00:00Z` : dateValue,
  );

const isDateOnly = (dateValue: string) => dateOnlyPattern.test(dateValue);

export const formatCourseScanStatus = (status: CourseScanStatus) => {
  switch (status) {
    case "pending":
      return { label: "Not fetched yet", Icon: CircleDashed };
    case "complete":
      return { label: "Up to date", Icon: CircleCheck };
    case "partial":
      return { label: "Partly read", Icon: CircleAlert };
    case "needs-sign-in":
      return { label: "Needs sign-in", Icon: KeyRound };
    case "blocked":
      return { label: "Not found", Icon: Ban };
    case "cancelled":
      return { label: "Refresh stopped", Icon: CircleStop };
  }
};

export const formatCourseSourceState = (state: CourseSourceState) => {
  switch (state) {
    case "connected":
      return { label: "Connected", Icon: Plug };
    case "unmarked":
      return { label: "No longer selected", Icon: CircleOff };
    case "removed":
      return { label: "Source removed", Icon: Ban };
  }
};

export const formatCourseDate = ({
  dateValue,
  dateText,
}: {
  dateValue: string | null;
  dateText: string | null;
}) => {
  const wording = dateText?.trim() || null;
  if (!dateValue) return wording;
  const instant = instantOf(dateValue);
  if (Number.isNaN(instant)) return wording;
  return new Intl.DateTimeFormat(
    undefined,
    isDateOnly(dateValue)
      ? {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }
      : {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
  ).format(new Date(instant));
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

// Text deadlines can name a day and local time without supplying a timezone.
const sortInstantOf = (item: {
  dateValue: string | null;
  dateText?: string | null;
}) => {
  if (item.dateValue) {
    const instant = instantOf(item.dateValue);
    if (Number.isFinite(instant)) return instant;
  }
  const text = item.dateText?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match =
    /^(?:due\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm))?$/i.exec(
      text,
    );
  if (!match) return null;
  const { dateValue } = storedDateFrom(match[1]);
  if (!dateValue) return null;
  if (!match[2]) return instantOf(dateValue);
  const hour = +match[2];
  const minute = +match[3];
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const localHour = (hour % 12) + (match[4].toLowerCase() === "pm" ? 12 : 0);
  return new Date(
    `${dateValue}T${String(localHour).padStart(2, "0")}:${match[3]}:00`,
  ).getTime();
};

// An unknown date never sorts ahead of a known one, whichever way the list runs.
const byDate =
  (direction: 1 | -1) =>
  <TItem extends { dateValue: string | null; dateText?: string | null }>(
    items: TItem[],
  ) =>
    [...items].sort((left, right) => {
      const first = sortInstantOf(left);
      const second = sortInstantOf(right);
      if (first === null && second === null) return 0;
      if (first === null) return 1;
      if (second === null) return -1;
      if (first === second) return 0;
      return first < second ? -direction : direction;
    });

export const sortAnnouncements = byDate(-1);
export const sortAssignments = byDate(1);

// Keep saved courses when a refresh finds no replacement results.
export const formatCoursesEmpty = (snapshot: CoursesSnapshot | null) => {
  if (!snapshot || !snapshot.sources.length) return "No courses saved yet.";
  return snapshot.sources.every((source) => source.outcome === "complete")
    ? "Your selected course sources were read and listed no courses."
    : "Courses were not found in your selected sources; your saved courses are unchanged.";
};

// One wording per combination so a tab never claims data it does not have.
export const formatCollectionState = (
  kind: "announcements" | "assignments",
  status: CourseScanStatus,
  count: number,
) => {
  if (count > 0)
    return status === "complete"
      ? null
      : `Saved ${kind} may be incomplete or out of date.`;
  switch (status) {
    case "pending":
      return `No ${kind} have been read yet.`;
    case "complete":
    case "blocked":
      return `No ${kind} found for this course.`;
    case "partial":
      return `Only part of this list could be read, and it showed no ${kind}.`;
    case "needs-sign-in":
      return `Sign in to this resource to read its ${kind}.`;
    case "cancelled":
      return `The refresh stopped before these ${kind} were read.`;
  }
};
