import { SyncDisclaimer } from '../../../features/courses/components/sync-disclaimer';
import { authenticationRefreshMessage } from '../../../features/courses/lib/refresh-presentation';
import { CourseCreateDialog } from '../../../features/courses/components/course-create-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import { CourseRecordActions } from '../../../features/courses/components/course-record-actions';
import { CourseRefreshActivity } from '../../../features/courses/components/course-refresh-activity';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  Clock,
  Layers,
  ClipboardList,
  Megaphone,
  ExternalLink,
  Eye,
  KeyRound,
  Loader2,
  RefreshCw,
  Plus,
  Pencil,
  SquareIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import { Card, CardContent } from '@scholaros/ui/components/card';
import { Input } from '@scholaros/ui/components/input';
import { Separator } from '@scholaros/ui/components/separator';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { PageHeading } from '../../../features/dashboard/page-heading';
import { defaultConnectionSearch } from '../../../features/dashboard/lib/connection-filters';
import { useCourses } from '../../../features/courses/hooks/use-courses';
import {
  formatCourseScanStatus,
  formatCourseSourceState,
} from '../../../features/courses/lib/formatters';
import { useOnboardingState } from '../../../features/onboarding/hooks/use-onboarding-state';
import { formatObservedAt } from '../../../features/onboarding/lib/formatters';
import { useBridgeAction } from '../../../hooks/use-bridge-action';

const CoursesPage = () => {
  const { state } = useOnboardingState();
  const {
    snapshot,
    loading,
    loadError,
    reload,
    refreshing,
    refresh,
    refreshError,
    cancel,
  } = useCourses(state?.accountId ?? null);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const search = debouncedQuery.trim().toLowerCase();
  const { busy, error, run } = useBridgeAction();
  const marked =
    state?.connections.filter((connection) => connection.isCourseResource) ??
    [];
  const signedOut = marked.filter(
    (connection) => connection.status === 'needs-sign-in',
  );
  const courses = snapshot?.courses ?? [];
  const inactive = courses.filter((course) => !course.active);
  const visible = courses
    .filter(
      (course) =>
        (showInactive || course.active) &&
        [
          course.name,
          course.code,
          course.content?.section,
          course.term,
          course.sourceName,
          course.sourceHost,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      }),
    );
  const canRefresh = marked.length > 0;
  return (
    <div className="flex flex-col gap-6 text-base">
      <PageHeading page="courses">
        <div className="flex flex-wrap items-center gap-3">
          <TooltipWrapper content="Watch settings">
            <Button
              variant="ghost"
              size="icon"
              nativeButton={false}
              aria-label="Watch settings"
              render={
                <Link to="/dashboard/settings" search={{ section: 'watch' }} />
              }
            >
              <Eye />
            </Button>
          </TooltipWrapper>
          {snapshot?.lastSuccessfulAt && (
            <p className="text-base flex items-center gap-2 text-muted-foreground">
              <Clock className="size-4 shrink-0" />
              Updated {formatObservedAt(snapshot.lastSuccessfulAt)}
            </p>
          )}
          {refreshing ? (
            <Button variant="outline" onClick={() => void cancel()}>
              <SquareIcon />
              Stop
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button disabled={loading} />}>
                <Plus />
                Add courses
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto">
                <TooltipWrapper
                  content={
                    canRefresh
                      ? 'Sync courses from your learning resources'
                      : 'Select a course resource in Connections to enable syncing.'
                  }
                >
                  <span className="block" tabIndex={canRefresh ? undefined : 0}>
                    <DropdownMenuItem
                      disabled={!canRefresh}
                      onClick={() => void refresh()}
                    >
                      <RefreshCw />
                      Sync courses
                    </DropdownMenuItem>
                  </span>
                </TooltipWrapper>
                <DropdownMenuItem onClick={() => setCreating(true)}>
                  <Pencil />
                  Add manually
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </PageHeading>
      <CourseCreateDialog
        open={creating}
        onOpenChange={setCreating}
        kind="courses"
      />
      <SyncDisclaimer />
      <CourseRefreshActivity activity={snapshot?.activity} />
      {loading && (
        <Loader2
          role="status"
          aria-label="Loading courses"
          className="size-6 animate-spin"
        />
      )}
      {loadError && (
        <Alert>
          <AlertDescription>{loadError}</AlertDescription>
          <Button onClick={() => void reload()}>Retry</Button>
        </Alert>
      )}
      {marked.length === 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Add courses manually or select a course resource in Connections to
            enable syncing.
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/dashboard/connections"
                  search={defaultConnectionSearch}
                />
              }
            >
              Manage connections
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {marked.length > 0 && signedOut.length === marked.length && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Sign in in your study browser, then refresh your courses.
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/dashboard/connections"
                  search={defaultConnectionSearch}
                />
              }
            >
              Manage connections
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {signedOut.length > 0 && signedOut.length < marked.length && (
        <div className="flex flex-col gap-1">
          {signedOut.map((connection) => (
            <p
              key={connection.id}
              className="text-base flex items-center gap-2 text-muted-foreground"
            >
              <KeyRound className="size-4 shrink-0" />
              {connection.name} needs you to sign in again.
            </p>
          ))}
        </div>
      )}
      {refreshing && (
        <p role="status" className="text-base flex items-center gap-2">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          Refreshing your courses…
        </p>
      )}
      {(error || refreshError) && (
        <Alert>
          <AlertDescription>{error || refreshError}</AlertDescription>
        </Alert>
      )}
      {snapshot?.sources
        .filter(
          (source) =>
            source.outcome === 'needs-sign-in' ||
            (source.message !== null &&
              authenticationRefreshMessage(new Error(source.message), '') !==
                null),
        )
        .map((source) => {
          const connection = marked.find(
            (item) => item.id === source.connectionId,
          );
          if (!connection) return null;
          const status = formatCourseScanStatus(source.outcome);
          return (
            <Alert key={source.connectionId}>
              <status.Icon />
              <AlertDescription className="flex items-center justify-between gap-3 text-base">
                <span className="text-base flex flex-col gap-1">
                  <span className="text-base font-medium">
                    {connection.name}
                  </span>
                  <span className="text-base">
                    {source.message ?? status.label}
                  </span>
                </span>
                <TooltipWrapper content="Open resource in study browser">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Open ${connection.name} in study browser`}
                    disabled={busy || refreshing}
                    onClick={() =>
                      void run(async () => {
                        await window.scholar.openSource(connection.url);
                      })
                    }
                  >
                    <ExternalLink />
                  </Button>
                </TooltipWrapper>
              </AlertDescription>
            </Alert>
          );
        })}
      {!loading && !courses.length && (
        <p className="text-base text-muted-foreground">
          No courses saved yet. Refresh your courses or add one manually.
        </p>
      )}
      {courses.length > 0 && (
        <Input
          type="search"
          aria-label="Search courses"
          placeholder="Search courses by name, code, term, or resource"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full text-base"
        />
      )}
      {search && courses.length > 0 && visible.length === 0 && (
        <p role="status" className="text-base text-muted-foreground">
          No courses match your search.
        </p>
      )}
      <div className="flex flex-col gap-3">
        {visible.map((course) => {
          const source =
            course.sourceState === 'connected'
              ? null
              : formatCourseSourceState(course.sourceState);
          return (
            <Card key={course.id} size="sm" className="text-base">
              <CardContent data-slot="course-card" className="gap-2">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      to="/dashboard/courses/$courseId"
                      params={{ courseId: course.id }}
                      className="min-w-0 truncate font-medium hover:underline"
                    >
                      {course.name}
                    </Link>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
                      {course.code && (
                        <span className="text-base truncate">
                          {course.code}
                        </span>
                      )}
                      {(course.code || course.term) && (
                        <Separator orientation="vertical" />
                      )}
                      {course.content?.section && (
                        <span
                          aria-label={`Section ${course.content.section}`}
                          className="flex items-center gap-2 text-base"
                        >
                          <Layers
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          {course.content.section}
                        </span>
                      )}
                      {course.term && (
                        <span className="text-base truncate">
                          {course.term}
                        </span>
                      )}
                      <span className="text-base truncate">
                        {course.sourceName}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {course.refreshing && (
                      <TooltipWrapper content="Refreshing course">
                        <span
                          role="status"
                          aria-label={`Refreshing ${course.name}`}
                        >
                          <LoadingSwap isLoading>
                            <RefreshCw className="size-4" />
                          </LoadingSwap>
                        </span>
                      </TooltipWrapper>
                    )}
                    <CourseRecordActions
                      kind="courses"
                      courseId={course.id}
                      course={course}
                      disabled={refreshing || course.refreshing}
                    />
                    {source && (
                      <TooltipWrapper content={source.label}>
                        <span tabIndex={0} aria-label={source.label}>
                          <source.Icon className="size-4 shrink-0 text-muted-foreground" />
                        </span>
                      </TooltipWrapper>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Megaphone aria-hidden="true" className="size-4 shrink-0" />
                    {course.announcementCount}{' '}
                    {course.announcementCount === 1
                      ? 'announcement'
                      : 'announcements'}
                  </span>
                  <span className="flex items-center gap-2">
                    <ClipboardList
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    {course.assignmentCount}{' '}
                    {course.assignmentCount === 1
                      ? 'assignment'
                      : 'assignments'}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {inactive.length > 0 && (
        <Button
          variant="ghost"
          className="self-start"
          aria-expanded={showInactive}
          onClick={() => setShowInactive((shown) => !shown)}
        >
          {showInactive
            ? 'Hide inactive courses'
            : `Show ${inactive.length} inactive course${
                inactive.length === 1 ? '' : 's'
              }`}
        </Button>
      )}
    </div>
  );
};

export const Route = createFileRoute('/dashboard/courses/')({
  component: CoursesPage,
});
