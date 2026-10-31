import {
  CalendarClock,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  Megaphone,
} from "lucide-react";
import { Button } from "@scholaros/ui/components/button";
import { Card, CardContent } from "@scholaros/ui/components/card";
import { Separator } from "@scholaros/ui/components/separator";
import { formatObservedAt } from "../../onboarding/lib/formatters";
import {
  formatCollectionState,
  formatCourseDate,
  formatCourseScanStatus,
  isPastDate,
  sortAnnouncements,
  sortAssignments,
} from "../lib/formatters";
import type { CourseScanStatus, SavedCourseChild } from "../types";

type CourseCollectionProps = {
  kind: "announcements" | "assignments";
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
  status,
  syncedAt,
  items,
  now,
  busy,
  onOpenSource,
}: CourseCollectionProps) => {
  const ItemIcon = kind === "assignments" ? ClipboardList : Megaphone;
  const formatted = formatCourseScanStatus(status);
  const showStatus = status !== "partial" && status !== "blocked";
  const ordered =
    kind === "announcements"
      ? sortAnnouncements(items)
      : sortAssignments(items);
  const notice = formatCollectionState(kind, status, ordered.length);
  return (
    <div className="flex flex-col gap-3">
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
                Updated {formatObservedAt(syncedAt)}
              </span>
            </>
          )}
        </div>
      )}
      {notice && <p className="text-base text-muted-foreground">{notice}</p>}
      {ordered.map((item) => {
        const dateLabel = formatCourseDate(item);
        const past = kind === "assignments" && isPastDate(item.dateValue, now);
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
                  </p>
                  {(dateLabel || past) && (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      {dateLabel && (
                        <span className="flex items-center gap-2 text-base">
                          <CalendarClock
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          {dateLabel}
                        </span>
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
                  {item.body && (
                    <p className="text-base text-muted-foreground">
                      {item.body}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  title="Open source"
                  aria-label={`Open ${item.title} at its source`}
                  disabled={busy}
                  onClick={() => onOpenSource(item.url)}
                >
                  <ExternalLink />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
