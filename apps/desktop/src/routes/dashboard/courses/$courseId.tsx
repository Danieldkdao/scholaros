import { CourseRefreshActivity } from '../../../features/courses/components/course-refresh-activity';
import { CourseRecordActions } from '../../../features/courses/components/course-record-actions';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FileImage,
  FileText,
  GraduationCap,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Upload,
} from 'lucide-react';
import type {
  ContextItemDTO,
  ContextKind,
  ContextProvenance,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@scholaros/ui/components/breadcrumb';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { Skeleton } from '@scholaros/ui/components/skeleton';
import { Separator } from '@scholaros/ui/components/separator';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@scholaros/ui/components/tabs';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { CourseCollection } from '../../../features/courses/components/course-collection';
import { HiddenCourseRecords } from '../../../features/courses/components/hidden-course-records';
import { useCourse } from '../../../features/courses/hooks/use-course';
import { ProgressSummary } from '../../../features/memory/components/progress-summary';
import { useOnboardingState } from '../../../features/onboarding/hooks/use-onboarding-state';
import { formatCourseSourceState } from '../../../features/courses/lib/formatters';
import { formatObservedAt } from '../../../features/onboarding/lib/formatters';
import { useBridgeAction } from '../../../hooks/use-bridge-action';

const formatContextKind = (kind: ContextKind) => {
  switch (kind) {
    case 'note':
      return { label: 'Note', Icon: Lightbulb };
    case 'preference':
      return { label: 'Preference', Icon: BookOpen };
    case 'document':
      return { label: 'Document', Icon: FileText };
    case 'image':
      return { label: 'Image', Icon: FileImage };
    case 'explanation':
      return { label: 'Explanation', Icon: Sparkles };
    case 'activity':
      return { label: 'Study activity', Icon: GraduationCap };
  }
};

const formatContextProvenance = (provenance: ContextProvenance) => {
  switch (provenance) {
    case 'user-authored':
      return { label: 'Written by you', Icon: BookOpen };
    case 'user-uploaded':
      return { label: 'Uploaded by you', Icon: Upload };
    case 'connected-source':
      return { label: 'Connected source', Icon: ExternalLink };
    case 'ai-generated':
      return { label: 'Created during study', Icon: Sparkles };
  }
};

const formatContextStatus = (status: IngestionStatus) => {
  switch (status) {
    case 'queued':
      return { label: 'Waiting to read', Icon: Loader2 };
    case 'processing':
      return { label: 'Reading', Icon: Loader2 };
    case 'complete':
      return { label: 'Ready to use', Icon: CircleCheck };
    case 'partial':
      return { label: 'Partially available', Icon: CircleAlert };
    case 'unreadable':
      return { label: 'Unreadable', Icon: CircleAlert };
    case 'unsupported':
      return { label: 'Unsupported', Icon: CircleAlert };
    case 'failed':
      return { label: 'Could not read', Icon: CircleAlert };
    case 'cancelled':
      return { label: 'Reading stopped', Icon: CircleAlert };
  }
};

type CourseContextMaterialsProps = {
  accountId: string | null;
  courseId: string;
};

const CourseContextMaterials = ({
  accountId,
  courseId,
}: CourseContextMaterialsProps) => {
  const [snapshot, setSnapshot] = useState<{
    accountId: string | null;
    items: ContextItemDTO[];
    loading: boolean;
    error: string | null;
  }>({ accountId: null, items: [], loading: true, error: null });
  const request = useRef(0);
  const accountMatches = snapshot.accountId === accountId;
  const items = accountMatches ? snapshot.items : [];
  const loading = accountMatches ? snapshot.loading : accountId !== null;
  const loadError = accountMatches ? snapshot.error : null;

  const load = useCallback(async () => {
    const attempt = ++request.current;
    if (!accountId) {
      setSnapshot({ accountId: null, items: [], loading: false, error: null });
      return;
    }
    setSnapshot((current) => ({
      accountId,
      items: current.accountId === accountId ? current.items : [],
      loading: true,
      error: null,
    }));
    try {
      if ((await window.scholar.getCurrentUser())?.id !== accountId) {
        if (attempt === request.current)
          setSnapshot({ accountId, items: [], loading: false, error: null });
        return;
      }
      const page = await window.scholar.listContextItems({
        courseId,
        limit: 25,
      });
      if (!page) throw new Error('Could not load this course library.');
      if (attempt !== request.current) return;
      if ((await window.scholar.getCurrentUser())?.id !== accountId) {
        setSnapshot({ accountId, items: [], loading: false, error: null });
        return;
      }
      setSnapshot({
        accountId,
        items: page.items.filter(
          (item) =>
            !item.source?.removed &&
            item.courseIds.includes(courseId) &&
            (item.kind === 'document' || item.kind === 'image'),
        ),
        loading: false,
        error: null,
      });
    } catch {
      if (attempt === request.current)
        setSnapshot({
          accountId,
          items: [],
          loading: false,
          error: 'Could not load this course library. Try again.',
        });
    }
  }, [accountId, courseId]);

  useEffect(() => {
    const unsubscribeProductEvents = window.scholar.onProductEvent((event) => {
      if (event.accountId === accountId && event.resource === 'context')
        void load();
    });
    const unsubscribeReconnect = window.scholar.onAcademicReconnect(
      (change) => {
        if (change.accountId === accountId) void load();
      },
    );
    void load();
    return () => {
      request.current += 1;
      unsubscribeProductEvents();
      unsubscribeReconnect();
    };
  }, [accountId, load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Course library</CardTitle>
        <CardDescription>
          Documents and images saved to this course.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && (
          <div role="status" aria-label="Loading course library">
            <Skeleton className="h-12 w-full motion-reduce:animate-none" />
          </div>
        )}
        {loadError && (
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </Alert>
        )}
        {!loading && !loadError && items.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No course materials yet</EmptyTitle>
              <EmptyDescription>
                Add a document or image in Context and link it to this course.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {items.length > 0 && (
          <ItemGroup>
            {items.map((item) => {
              const kind = formatContextKind(item.kind);
              const provenance = formatContextProvenance(item.provenance);
              const status = formatContextStatus(item.status);
              return (
                <Item
                  key={item.id}
                  variant="outline"
                  render={
                    <Link
                      to="/dashboard/context"
                      search={{ itemId: item.id }}
                    />
                  }
                >
                  <ItemMedia variant="icon">
                    <kind.Icon
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="max-w-full text-base">
                      {item.title}
                    </ItemTitle>
                    <ItemDescription className="flex flex-wrap items-center gap-2 text-base">
                      <span>{kind.label}</span>
                      <Separator orientation="vertical" className="h-4" />
                      <provenance.Icon aria-hidden="true" className="size-4" />
                      <span>{provenance.label}</span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <status.Icon
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                    <span className="text-base text-muted-foreground">
                      {status.label}
                    </span>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
};

const CoursePage = () => {
  const { courseId } = Route.useParams();
  const navigate = Route.useNavigate();
  const { state } = useOnboardingState();
  const { course, loading, loadError, reload, refreshing, refresh, stop } =
    useCourse(courseId, state?.accountId ?? null);
  const { busy, error, run } = useBridgeAction();
  const now = new Date().toISOString();
  const source = course
    ? course.sourceState === 'connected'
      ? null
      : formatCourseSourceState(course.sourceState)
    : null;
  const overviewRows = course
    ? [
        { label: 'Course', value: course.name },
        { label: 'Code', value: course.code },
        { label: 'Term', value: course.term },
        { label: 'Instructor', value: course.instructor },
        { label: 'Description', value: course.description },
      ].filter((row) => !!row.value)
    : [];
  const openSource = (url: string) =>
    run(async () => {
      await window.scholar.openSource(url);
    });
  return (
    <div className="flex flex-col gap-6 text-base">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/dashboard/courses" />}>
              Courses
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{course?.name ?? 'Course'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-3xl font-semibold">
          {course?.name ?? 'Course'}
        </h1>
        <div className="flex items-center gap-2">
          {course && (
            <CourseRecordActions
              kind="courses"
              courseId={courseId}
              course={course}
              disabled={refreshing}
              onDeleted={() => void navigate({ to: '/dashboard/courses' })}
            />
          )}
          {course && (
            <TooltipWrapper content={`Start studying ${course.name}`}>
              <Button
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: '/dashboard/study',
                    search: { courseId: course.id },
                  })
                }
              >
                <GraduationCap aria-hidden="true" />
                Start studying
              </Button>
            </TooltipWrapper>
          )}
          {course && (
            <HiddenCourseRecords
              courseId={course.id}
              courseTitle={course.name}
              connectionId={course.connectionId}
              restoreDisabled={refreshing}
              onRestored={() => void reload()}
            />
          )}
          {course?.sourceState === 'connected' && (
            <TooltipWrapper
              content={refreshing ? 'Stop refreshing course' : 'Refresh course'}
            >
              <Button
                variant="outline"
                size="icon"
                aria-label={
                  refreshing ? 'Stop refreshing course' : 'Refresh course'
                }
                onClick={() => void (refreshing ? stop() : refresh())}
              >
                {refreshing ? <Square /> : <RefreshCw />}
              </Button>
            </TooltipWrapper>
          )}
          {course && course.url && course.sourceState !== 'removed' && (
            <TooltipWrapper content={`Open ${course.sourceName}`}>
              <Button
                variant="outline"
                size="icon"
                aria-label="Open source"
                disabled={busy}
                onClick={() => void openSource(course.url)}
              >
                <ExternalLink />
              </Button>
            </TooltipWrapper>
          )}
        </div>
      </div>
      <CourseRefreshActivity activity={course?.activity} />
      {loading && (
        <Loader2
          role="status"
          aria-label="Loading course"
          className="size-6 animate-spin"
        />
      )}
      {loadError && (
        <Alert>
          <AlertDescription>{loadError}</AlertDescription>
          <Button onClick={() => void reload()}>Retry</Button>
        </Alert>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !loadError && !course && (
        <p className="text-base text-muted-foreground">
          This course is not available.
        </p>
      )}
      {course && (
        <Tabs defaultValue="overview">
          <TabsList className="w-full">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="announcements">Announcements</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            <TabsTrigger value="materials">Materials</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Card size="sm" className="text-base">
              <CardContent className="gap-3">
                {overviewRows.map((row) => (
                  <div key={row.label} className="flex flex-col gap-1">
                    <p className="text-base text-muted-foreground">
                      {row.label}
                    </p>
                    <p className="text-base">{row.value}</p>
                  </div>
                ))}
                <Separator />
                <div className="flex flex-col gap-1">
                  <p className="text-base text-muted-foreground">Source</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {course.sourceName}
                    {source && (
                      <>
                        <Separator orientation="vertical" className="h-4" />
                        <source.Icon className="size-4 shrink-0" />
                        <span className="text-base text-muted-foreground">
                          {source.label}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-base text-muted-foreground">Last read</p>
                  <p className="text-base">
                    {course.overviewSyncedAt
                      ? formatObservedAt(course.overviewSyncedAt)
                      : 'Not read yet'}
                  </p>
                </div>
              </CardContent>
            </Card>
            {state?.accountId && (
              <ProgressSummary
                accountId={state.accountId}
                courseId={course.id}
              />
            )}
          </TabsContent>
          <TabsContent value="announcements">
            <CourseCollection
              courseId={courseId}
              refreshing={refreshing}
              kind="announcements"
              status={course.announcementsStatus}
              syncedAt={course.announcementsSyncedAt}
              items={course.announcements}
              now={now}
              busy={busy}
              onOpenSource={(url) => void openSource(url)}
            />
          </TabsContent>
          <TabsContent value="assignments">
            <CourseCollection
              courseId={courseId}
              refreshing={refreshing}
              kind="assignments"
              status={course.assignmentsStatus}
              syncedAt={course.assignmentsSyncedAt}
              items={course.assignments}
              now={now}
              busy={busy}
              onOpenSource={(url) => void openSource(url)}
            />
          </TabsContent>
          <TabsContent value="materials">
            <CourseContextMaterials
              accountId={state?.accountId ?? null}
              courseId={course.id}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export const Route = createFileRoute('/dashboard/courses/$courseId')({
  component: CoursePage,
});
