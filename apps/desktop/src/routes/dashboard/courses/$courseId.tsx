import { createFileRoute, Link } from '@tanstack/react-router';
import { ExternalLink, Loader2 } from 'lucide-react';
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
import { Card, CardContent } from '@scholaros/ui/components/card';
import { Separator } from '@scholaros/ui/components/separator';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@scholaros/ui/components/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@scholaros/ui/components/tooltip';
import { CourseCollection } from '../../../features/courses/components/course-collection';
import { useCourse } from '../../../features/courses/hooks/use-course';
import { formatCourseSourceState } from '../../../features/courses/lib/formatters';
import { formatObservedAt } from '../../../features/onboarding/lib/formatters';
import { useBridgeAction } from '../../../hooks/use-bridge-action';

const CoursePage = () => {
  const { courseId } = Route.useParams();
  const { course, loading, loadError, reload } = useCourse(courseId);
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
        {course && course.sourceState !== 'removed' && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Open source"
                  disabled={busy}
                  onClick={() => void openSource(course.url)}
                />
              }
            >
              <ExternalLink />
            </TooltipTrigger>
            <TooltipContent>Open {course.sourceName}</TooltipContent>
          </Tooltip>
        )}
      </div>
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
          </TabsContent>
          <TabsContent value="announcements">
            <CourseCollection
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
              kind="assignments"
              status={course.assignmentsStatus}
              syncedAt={course.assignmentsSyncedAt}
              items={course.assignments}
              now={now}
              busy={busy}
              onOpenSource={(url) => void openSource(url)}
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
