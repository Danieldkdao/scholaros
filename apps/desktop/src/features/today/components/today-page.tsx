import { useState, type ComponentType } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CircleAlert,
  Clock3,
  Plug,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { toast } from '@scholaros/ui/components/toast';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
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
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { Skeleton } from '@scholaros/ui/components/skeleton';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import type { Recommendation } from '@scholaros/services/learning/today-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { SafeRoute } from '@scholaros/services/learning/notification-contracts';
import { errorMessage } from '../../../lib/error-message';
import { PageHeading } from '../../dashboard/page-heading';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import { useToday } from '../hooks/use-today';
import {
  formatStudyActivity,
  formatStudySessionStatus,
  formatTodayAcademicDate,
  formatTodayCollectionEmpty,
  formatTodayCourseStatus,
  formatTodayItemSource,
  formatTodayReadError,
} from '../lib/formatters';
import { StudyRecommendations } from './study-recommendations';
import { TodayAttention } from './today-attention';

type ProgressSummaryProps = { accountId: string };
type TodayPageProps = {
  accountId: string | null;
  ProgressSummaryComponent: ComponentType<ProgressSummaryProps>;
};

const navigateSafeRoute = (
  navigate: ReturnType<typeof useNavigate>,
  route: SafeRoute,
) => {
  switch (route.kind) {
    case 'today':
      void navigate({ to: '/dashboard' } as never);
      break;
    case 'settings':
      void navigate({
        to: '/dashboard/settings',
        search: { section: route.section },
      } as never);
      break;
    case 'course':
      void navigate({
        to: '/dashboard/courses/$courseId',
        params: { courseId: route.courseId },
      } as never);
      break;
    case 'context':
      void navigate(
        route.itemId
          ? ({
              to: '/dashboard/context',
              search: { itemId: route.itemId },
            } as never)
          : ({ to: '/dashboard/context' } as never),
      );
      break;
    case 'study':
      void navigate({
        to: '/study/$sessionId',
        params: { sessionId: route.sessionId },
      } as never);
      break;
  }
};

const OpenCourseButton = ({
  courseId,
  courseName,
  onOpen,
}: {
  courseId: string;
  courseName: string;
  onOpen: (courseId: string) => void;
}) => {
  const label = `Open ${courseName}`;
  return (
    <TooltipWrapper content={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={() => onOpen(courseId)}
      >
        <ArrowUpRight aria-hidden="true" />
      </Button>
    </TooltipWrapper>
  );
};

const TodayLoading = () => (
  <div
    className="grid gap-4 md:grid-cols-2"
    aria-label="Loading Today"
    role="status"
  >
    {Array.from({ length: 4 }, (_, index) => (
      <Card key={index}>
        <CardHeader>
          <Skeleton className="h-6 w-40 motion-reduce:animate-none" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full motion-reduce:animate-none" />
          <Skeleton className="h-12 w-full motion-reduce:animate-none" />
        </CardContent>
      </Card>
    ))}
  </div>
);

export const TodayPage = ({
  accountId,
  ProgressSummaryComponent,
}: TodayPageProps) => {
  const navigate = useNavigate();
  const { snapshot, loading, error, offline, reload } = useToday(accountId);
  const [syncing, setSyncing] = useState(false);
  const courseNameById = new Map(
    (snapshot?.recentCourses ?? []).map((course) => [course.id, course.name]),
  );
  const getCourseName = (courseId: string) =>
    courseNameById.get(courseId) ?? 'Course';

  const navigateTo = (route: SafeRoute) => navigateSafeRoute(navigate, route);
  const openCourse = (courseId: string) =>
    navigateSafeRoute(navigate, { kind: 'course', courseId });
  const openSource = async (reference: SourceReference) => {
    try {
      switch (reference.sourceKind) {
        case 'assignment': {
          if (!reference.courseId) return;
          const course = await window.scholar.getCourse(reference.courseId);
          const item = course?.assignments.find(
            (assignment) =>
              assignment.id === reference.sourceId && assignment.active,
          );
          if (!item) {
            toast.error(
              'This assignment source is no longer available in the selected course.',
            );
            return;
          }
          await window.scholar.openSource(item.url);
          return;
        }
        case 'announcement': {
          if (!reference.courseId) return;
          const course = await window.scholar.getCourse(reference.courseId);
          const item = course?.announcements.find(
            (announcement) =>
              announcement.id === reference.sourceId && announcement.active,
          );
          if (!item) {
            toast.error(
              'This announcement source is no longer available in the selected course.',
            );
            return;
          }
          await window.scholar.openSource(item.url);
          return;
        }
        case 'course-material':
        case 'grade-evidence':
          if (reference.courseId) openCourse(reference.courseId);
          return;
        case 'context-version':
        case 'saved-activity':
          navigateSafeRoute(navigate, {
            kind: 'context',
            itemId: reference.sourceId,
          });
          return;
      }
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not open this course source.'));
    }
  };
  const startStudy = (recommendation?: Recommendation) => {
    void navigate({
      to: '/dashboard/study',
      search: recommendation
        ? {
            activity: recommendation.activity,
            ...(recommendation.courseId
              ? { courseId: recommendation.courseId }
              : {}),
            ...(recommendation.targetAssignmentId
              ? { targetAssignmentId: recommendation.targetAssignmentId }
              : {}),
            ...(recommendation.topic ? { topic: recommendation.topic } : {}),
          }
        : {},
    } as never);
  };
  const resumeSession = (sessionId: string) =>
    navigateSafeRoute(navigate, { kind: 'study', sessionId });
  const syncCourses = async () => {
    setSyncing(true);
    try {
      const result = await window.scholar.refreshCourses();
      if (!result)
        throw new Error('The course refresh did not return an update.');
      await reload();
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not refresh your classes.'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 text-base">
      <PageHeading page="today">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!accountId}
            onClick={() =>
              void navigate({ to: '/dashboard/connections' } as never)
            }
          >
            <Plug aria-hidden="true" />
            Manage connections
          </Button>
          <Button
            variant="outline"
            disabled={!accountId}
            onClick={() => void navigateTo({ kind: 'context', itemId: null })}
          >
            <BookOpen aria-hidden="true" />
            Open Context
          </Button>
          <Button
            variant="outline"
            disabled={!accountId}
            onClick={() =>
              void navigateTo({ kind: 'settings', section: 'connections' })
            }
          >
            <Settings2 aria-hidden="true" />
            Open settings
          </Button>
          <Button
            variant="outline"
            disabled={syncing || !accountId}
            onClick={() => void syncCourses()}
          >
            <LoadingSwap isLoading={syncing}>
              <RefreshCw aria-hidden="true" />
              Refresh classes
            </LoadingSwap>
          </Button>
        </div>
      </PageHeading>

      {error && snapshot && (
        <div className="flex flex-wrap items-center gap-3">
          <Alert role="status" className="flex-1">
            {offline ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <Clock3 aria-hidden="true" />
            )}
            <AlertDescription>{formatTodayReadError(offline)}</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void reload()}
          >
            <LoadingSwap isLoading={loading}>Retry Today overview</LoadingSwap>
          </Button>
        </div>
      )}
      {loading && snapshot && (
        <p className="text-base text-muted-foreground" role="status">
          Refreshing your saved overview…
        </p>
      )}

      {!accountId ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-base text-muted-foreground" role="status">
              Waiting for your account before loading Today.
            </p>
          </CardContent>
        </Card>
      ) : !snapshot && loading ? (
        <TodayLoading />
      ) : !snapshot ? (
        <Card>
          <CardContent className="flex flex-col gap-4 p-6">
            <Alert role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                {error ?? formatTodayReadError(offline)}
              </AlertDescription>
            </Alert>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void reload()}
            >
              <LoadingSwap isLoading={loading}>
                Retry Today overview
              </LoadingSwap>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <TodayAttention
            attention={snapshot.attention}
            freshness={snapshot.freshness}
            courses={snapshot.recentCourses}
            onNavigate={navigateTo}
          />

          <StudyRecommendations
            recommendations={snapshot.recommendations}
            onStart={startStudy}
            onOpenSource={openSource}
          />

          {accountId && <ProgressSummaryComponent accountId={accountId} />}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Upcoming assignments and exams</CardTitle>
              </CardHeader>
              <CardContent>
                {snapshot.upcoming.length ? (
                  <ItemGroup>
                    {snapshot.upcoming.map((item) => {
                      const date = formatTodayAcademicDate(item.date);
                      const DateIcon = date.Icon;
                      return (
                        <Item
                          key={`${item.courseId}-${item.resourceId}`}
                          variant="outline"
                          role="listitem"
                          className="text-base"
                        >
                          <ItemMedia variant="icon">
                            <DateIcon
                              aria-hidden="true"
                              className="size-4 text-muted-foreground"
                            />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle className="text-base">
                              {item.title}
                            </ItemTitle>
                            <p className="text-base text-muted-foreground">
                              {getCourseName(item.courseId)}{' '}
                              <ArrowRight
                                aria-hidden="true"
                                className="inline size-4"
                              />{' '}
                              {date.label}
                            </p>
                            <p className="text-base text-muted-foreground">
                              {date.precisionLabel}
                            </p>
                          </ItemContent>
                          <ItemActions>
                            {date.overdue && (
                              <span className="text-base text-destructive">
                                Overdue
                              </span>
                            )}
                            <OpenCourseButton
                              courseId={item.courseId}
                              courseName={getCourseName(item.courseId)}
                              onOpen={openCourse}
                            />
                          </ItemActions>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                ) : (
                  <Empty className="border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>No upcoming assignments or exams</EmptyTitle>
                      <EmptyDescription className="text-base">
                        Connect a course or refresh saved class information to
                        see reported due dates.
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button
                      variant="outline"
                      disabled={!accountId}
                      onClick={() =>
                        void navigateTo({
                          kind: 'settings',
                          section: 'connections',
                        })
                      }
                    >
                      Connect a course
                    </Button>
                  </Empty>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Course announcements</CardTitle>
              </CardHeader>
              <CardContent>
                {snapshot.announcements.length ? (
                  <ItemGroup>
                    {snapshot.announcements.map((announcement) => (
                      <Item
                        key={`${announcement.courseId}-${announcement.id}`}
                        variant="outline"
                        role="listitem"
                        className="text-base"
                      >
                        <ItemMedia variant="icon">
                          <BookOpen
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                          />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="text-base">
                            {announcement.title}
                          </ItemTitle>
                          <p className="text-base text-muted-foreground">
                            {announcement.courseName ??
                              getCourseName(announcement.courseId)}
                          </p>
                          {announcement.preview && (
                            <p className="line-clamp-3 text-base text-muted-foreground">
                              {announcement.preview}
                            </p>
                          )}
                          {announcement.publishedAt && (
                            <p className="text-base text-muted-foreground">
                              Published{' '}
                              {formatObservedAt(announcement.publishedAt)}
                            </p>
                          )}
                        </ItemContent>
                        <ItemActions>
                          <OpenCourseButton
                            courseId={announcement.courseId}
                            courseName={
                              announcement.courseName ??
                              getCourseName(announcement.courseId)
                            }
                            onOpen={openCourse}
                          />
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                ) : (
                  <Empty className="border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>No announcements saved yet</EmptyTitle>
                      <EmptyDescription className="text-base">
                        {formatTodayCollectionEmpty('announcements')}
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button
                      variant="outline"
                      disabled={!accountId}
                      onClick={() =>
                        void navigate({ to: '/dashboard/connections' } as never)
                      }
                    >
                      Manage connections
                    </Button>
                  </Empty>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent courses and materials</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {snapshot.recentCourses.length ? (
                  <ItemGroup>
                    {snapshot.recentCourses.map((course) => {
                      const { Icon, label } = formatTodayCourseStatus(
                        course.active,
                      );
                      return (
                        <Item
                          key={course.id}
                          variant="outline"
                          size="sm"
                          role="listitem"
                          className="text-base"
                        >
                          <ItemMedia variant="icon">
                            <Icon
                              aria-hidden="true"
                              className="size-4 text-muted-foreground"
                            />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle className="text-base">
                              {course.name}
                            </ItemTitle>
                            <p className="text-base text-muted-foreground">
                              {label}{' '}
                              <ArrowRight
                                aria-hidden="true"
                                className="inline size-4"
                              />{' '}
                              {course.sourceName}
                            </p>
                            {course.code && (
                              <p className="text-base text-muted-foreground">
                                {course.code}
                              </p>
                            )}
                          </ItemContent>
                          <ItemActions>
                            <OpenCourseButton
                              courseId={course.id}
                              courseName={course.name}
                              onOpen={openCourse}
                            />
                          </ItemActions>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                ) : (
                  <Empty className="border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>No courses saved yet</EmptyTitle>
                      <EmptyDescription className="text-base">
                        Connect a course source to see your saved classes and
                        materials.
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button
                      variant="outline"
                      disabled={!accountId}
                      onClick={() =>
                        void navigateTo({
                          kind: 'settings',
                          section: 'connections',
                        })
                      }
                    >
                      Connect a course
                    </Button>
                  </Empty>
                )}
                {snapshot.recentMaterials.length ? (
                  <ItemGroup>
                    {snapshot.recentMaterials.map((reference) => (
                      <Item
                        key={`${reference.sourceKind}-${reference.sourceId}-${reference.versionId ?? 'current'}`}
                        variant="outline"
                        size="sm"
                        role="listitem"
                        className="text-base"
                      >
                        <ItemMedia variant="icon">
                          <BookOpen
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                          />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="text-base">
                            {reference.title ?? 'Saved course material'}
                          </ItemTitle>
                          <p className="text-base text-muted-foreground">
                            {reference.courseId
                              ? 'Course material'
                              : formatTodayItemSource(reference.sourceKind)}
                          </p>
                        </ItemContent>
                        {reference.courseId && (
                          <ItemActions>
                            <OpenCourseButton
                              courseId={reference.courseId}
                              courseName={getCourseName(reference.courseId)}
                              onOpen={openCourse}
                            />
                          </ItemActions>
                        )}
                      </Item>
                    ))}
                  </ItemGroup>
                ) : snapshot.recentCourses.length ? (
                  <p className="text-base text-muted-foreground">
                    Course files will appear here when syncing finds them.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent study sessions</CardTitle>
              </CardHeader>
              <CardContent>
                {snapshot.recentSessions.length ? (
                  <ItemGroup>
                    {snapshot.recentSessions.map((session) => {
                      const { Icon: ActivityIcon, label: activityLabel } =
                        formatStudyActivity(session.activity);
                      const { Icon: StatusIcon, label: statusLabel } =
                        formatStudySessionStatus(session.status);
                      const actionLabel =
                        session.status === 'interrupted' ||
                        session.status === 'in-progress'
                          ? 'Resume session'
                          : 'Open session';
                      return (
                        <Item
                          key={session.id}
                          variant="outline"
                          role="listitem"
                          className="text-base"
                        >
                          <ItemMedia variant="icon">
                            <ActivityIcon
                              aria-hidden="true"
                              className="size-4 text-muted-foreground"
                            />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle className="text-base">
                              {session.title}
                            </ItemTitle>
                            <p className="text-base text-muted-foreground">
                              {activityLabel} <span aria-hidden="true">→</span>{' '}
                              {statusLabel}
                            </p>
                            <p className="text-base text-muted-foreground">
                              Updated {formatObservedAt(session.updatedAt)}
                            </p>
                            {session.draft.text.trim() && (
                              <p className="line-clamp-2 text-base text-muted-foreground">
                                {session.draft.text.trim().slice(0, 160)}
                              </p>
                            )}
                          </ItemContent>
                          <ItemActions>
                            <Button
                              variant="outline"
                              onClick={() => resumeSession(session.id)}
                            >
                              <StatusIcon aria-hidden="true" />
                              {actionLabel}
                            </Button>
                          </ItemActions>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                ) : (
                  <Empty className="border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>No recent study sessions</EmptyTitle>
                      <EmptyDescription className="text-base">
                        Saved sessions will appear here and can be resumed with
                        their existing notes.
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button variant="outline" onClick={() => startStudy()}>
                      <CalendarDays aria-hidden="true" />
                      Start a study session
                    </Button>
                  </Empty>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
