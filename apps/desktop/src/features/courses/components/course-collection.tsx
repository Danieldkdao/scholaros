import { useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { Input } from '@scholaros/ui/components/input';
import { CourseCreateDialog } from './course-create-dialog';
import { CourseRecordActions } from './course-record-actions';
import {
  Plus,
  CalendarClock,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  Megaphone,
} from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { Card, CardContent } from '@scholaros/ui/components/card';
import { Separator } from '@scholaros/ui/components/separator';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import {
  formatCollectionState,
  formatAssignmentState,
  formatCourseDate,
  formatAcademicDateResolution,
  formatCourseScanStatus,
  isPastDate,
  sortAnnouncements,
  sortAssignments,
} from '../lib/formatters';
import { academicDateFor } from '../lib/dates';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import type { CourseScanStatus, SavedCourseChild } from '../types';

type CourseCollectionProps = {
  kind: 'announcements' | 'assignments';
  courseId: string;
  refreshing?: boolean;
  status: CourseScanStatus;
  syncedAt: string | null;
  items: SavedCourseChild[];
  now: string;
  busy: boolean;
  onOpenSource: (url: string) => void;
};

// Announcements and assignments differ only in which end of the calendar they
// read from, so one list serves both.
export const CourseCollection = ({
  kind,
  courseId,
  refreshing,
  status,
  syncedAt,
  items,
  now,
  busy,
  onOpenSource,
}: CourseCollectionProps) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const [creating, setCreating] = useState(false);
  const search = debouncedQuery.trim().toLowerCase();
  const visible = items.filter((item) =>
    [
      item.title,
      item.body,
      item.content &&
        ('description' in item.content
          ? item.content.description
          : item.content.body),
    ]
      .join(' ')
      .toLowerCase()
      .includes(search),
  );
  const ItemIcon = kind === 'assignments' ? ClipboardList : Megaphone;
  const formatted = formatCourseScanStatus(status);
  const showStatus =
    status === 'complete' || status === 'pending' || status === 'needs-sign-in';
  const ordered =
    kind === 'announcements'
      ? sortAnnouncements(visible)
      : sortAssignments(visible);
  const notice = showStatus
    ? formatCollectionState(kind, status, items.length)
    : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          type="search"
          className="w-full text-base"
          aria-label={`Search ${kind}`}
          placeholder={`Search ${kind}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <TooltipWrapper
          content={
            kind === 'assignments' ? 'Add assignment' : 'Add announcement'
          }
        >
          <Button
            size="icon"
            aria-label={
              kind === 'assignments' ? 'Add assignment' : 'Add announcement'
            }
            disabled={refreshing}
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        </TooltipWrapper>
      </div>
      <CourseCreateDialog
        open={creating}
        onOpenChange={setCreating}
        kind={kind}
        courseId={courseId}
      />
      {search && ordered.length === 0 && (
        <p role="status" className="text-base text-muted-foreground">
          No {kind} match your search.
        </p>
      )}
      {(showStatus || syncedAt) && (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {showStatus && (
            <>
              <formatted.Icon className="size-4 shrink-0" />
              <span className="text-base">{formatted.label}</span>
            </>
          )}
          {syncedAt && (
            <>
              {showStatus && (
                <Separator orientation="vertical" className="h-4" />
              )}
              <span className="text-base">
                Checked {formatObservedAt(syncedAt)}
              </span>
            </>
          )}
        </div>
      )}
      {notice && <p className="text-base text-muted-foreground">{notice}</p>}
      {ordered.map((item) => {
        const body = item.content
          ? 'description' in item.content
            ? item.content.description
            : item.content.body
          : item.body;
        const uncertainStatus =
          kind === 'assignments' &&
          item.content &&
          'state' in item.content &&
          item.content.state === 'unknown'
            ? formatAssignmentState(item.content.state)
            : null;
        const dateLabel = formatCourseDate(item);
        const date = academicDateFor(item);
        const resolution = formatAcademicDateResolution(date);
        const past =
          kind === 'assignments' &&
          isPastDate(date?.kind === 'instant' ? date.instant : null, now);
        return (
          <Card key={item.id} size="sm" className="text-base">
            <CardContent data-slot={`${kind}-card`} className="gap-2">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="flex items-start gap-2 text-base font-medium">
                    <ItemIcon
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-muted-foreground"
                    />
                    {item.title}
                    {uncertainStatus && (
                      <TooltipWrapper content={uncertainStatus.label}>
                        <span
                          tabIndex={0}
                          role="img"
                          aria-label={uncertainStatus.label}
                          className="flex shrink-0 items-center text-muted-foreground"
                        >
                          <uncertainStatus.Icon
                            aria-hidden="true"
                            className="size-4"
                          />
                        </span>
                      </TooltipWrapper>
                    )}
                  </p>
                  {(dateLabel || past) && (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      {dateLabel && (
                        <TooltipWrapper content={resolution.label}>
                          <span
                            tabIndex={0}
                            className="flex items-center gap-2 text-base"
                          >
                            <CalendarClock
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            {dateLabel}
                          </span>
                        </TooltipWrapper>
                      )}
                      {dateLabel && past && (
                        <Separator orientation="vertical" className="h-4" />
                      )}
                      {past && (
                        <span className="flex items-center gap-2 text-base">
                          <CircleAlert
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          Past due
                        </span>
                      )}
                    </div>
                  )}
                  {body && (
                    <p className="text-base text-muted-foreground">{body}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <CourseRecordActions
                    kind={kind}
                    courseId={courseId}
                    item={item}
                    disabled={refreshing}
                  />
                  <TooltipWrapper content="Open source">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label={`Open ${item.title} at its source`}
                      disabled={busy || !item.url}
                      onClick={() => onOpenSource(item.url)}
                    >
                      <ExternalLink />
                    </Button>
                  </TooltipWrapper>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
