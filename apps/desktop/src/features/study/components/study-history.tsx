import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription as RenameDialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@scholaros/ui/components/field';
import { Input } from '@scholaros/ui/components/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemHeader,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { toast } from '@scholaros/ui/components/toast';
import { BookOpen, Clock3, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { studySessionStatuses } from '@scholaros/services/learning/study-contracts';
import type {
  StudySessionDTO,
  StudySessionStatus,
} from '@scholaros/services/learning/study-contracts';
import { useConfirm } from '../../../hooks/use-confirm';
import { useCourses } from '../../courses/hooks/use-courses';
import { errorMessage } from '../../../lib/error-message';
import { useStudyHistory } from '../hooks/use-study-history';
import {
  formatStudyActivity,
  formatStudySessionStatus,
  formatStudyUpdatedAt,
} from '../lib/formatters';

const allCoursesValue = '__all_courses__';
const allStatusesValue = '__all_statuses__';

type StudyHistoryProps = {
  accountId: string;
  offline?: boolean;
  onResume: (sessionId: string) => void | Promise<void>;
};

export const StudyHistory = ({
  accountId,
  offline = false,
  onResume,
}: StudyHistoryProps) => {
  const { snapshot: coursesSnapshot } = useCourses(accountId);
  const {
    sessions,
    query,
    setQuery,
    courseId,
    setCourseId,
    status,
    setStatus,
    loading,
    loadingMore,
    loadError,
    loadMoreError,
    hasMore,
    reload,
    loadMore,
    renameSession,
    deleteSession,
  } = useStudyHistory({ accountId });
  const [renameTarget, setRenameTarget] = useState<StudySessionDTO | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const confirmation = useConfirm<StudySessionDTO>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const courses = coursesSnapshot?.courses ?? [];
  const courseItems = [
    { value: allCoursesValue, label: 'All courses' },
    ...courses.map((course) => ({ value: course.id, label: course.name })),
  ];
  const statusItems = [
    { value: allStatusesValue, label: 'All statuses' },
    ...studySessionStatuses.map((value) => ({
      value,
      label: formatStudySessionStatus(value).label,
    })),
  ];
  const hasActiveFilters = Boolean(query.trim() || courseId || status);

  const openRename = (session: StudySessionDTO) => {
    setRenameTarget(session);
    setRenameTitle(session.title);
    setRenameError(null);
  };

  const saveRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameTarget || !renameTitle.trim() || renameTitle.length > 160)
      return;
    setRenaming(true);
    setRenameError(null);
    try {
      await renameSession(renameTarget, renameTitle);
      setRenameTarget(null);
    } catch (cause) {
      setRenameError(
        errorMessage(
          cause,
          'Could not rename this session. Your title is still here.',
        ),
      );
    } finally {
      setRenaming(false);
    }
  };

  const removeSession = async () => {
    if (!confirmation.pending) return;
    const shouldRefill = sessions.length === 1 && hasMore;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSession(confirmation.pending);
      confirmation.cancel();
      if (shouldRefill) await reload();
      toast.success('Study session deleted');
    } catch (cause) {
      setDeleteError(errorMessage(cause, 'Could not delete this session.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>Study history</CardTitle>
            <CardDescription>
              Search, filter, rename, resume, or delete a saved session.
            </CardDescription>
          </div>
          <TooltipWrapper content="Refresh study history">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh history"
              aria-busy={loading}
              disabled={loading}
              onClick={() => void reload()}
            >
              <LoadingSwap isLoading={loading}>
                <RefreshCw aria-hidden="true" />
              </LoadingSwap>
            </Button>
          </TooltipWrapper>
        </div>
      </CardHeader>
      <CardContent>
        {offline && (
          <Alert>
            <AlertDescription>
              Offline history is read-only. Reconnect to rename or delete a
              session.
            </AlertDescription>
          </Alert>
        )}
        <FieldGroup className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field className="md:col-span-1">
            <FieldLabel htmlFor="study-history-search">Search</FieldLabel>
            <Input
              id="study-history-search"
              aria-label="Search study history"
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search session titles and topics"
              className="w-full text-base"
            />
          </Field>
          <Field>
            <FieldLabel id="study-history-course-label">Course</FieldLabel>
            <Select
              value={courseId ?? allCoursesValue}
              onValueChange={(value) =>
                setCourseId(
                  typeof value === 'string' && value !== allCoursesValue
                    ? value
                    : null,
                )
              }
              items={courseItems}
            >
              <SelectTrigger
                className="w-full"
                aria-label="History course"
                aria-labelledby="study-history-course-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={allCoursesValue}>All courses</SelectItem>
                {courses.map((course) => (
                  <SelectItem key={course.id} value={course.id}>
                    {course.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel id="study-history-status-label">Status</FieldLabel>
            <Select
              value={status ?? allStatusesValue}
              onValueChange={(value) =>
                setStatus(
                  typeof value === 'string' && value !== allStatusesValue
                    ? (value as StudySessionStatus)
                    : null,
                )
              }
              items={statusItems}
            >
              <SelectTrigger
                className="w-full"
                aria-label="History status"
                aria-labelledby="study-history-status-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={allStatusesValue}>All statuses</SelectItem>
                {studySessionStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatStudySessionStatus(value).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        {loading && (
          <div
            role="status"
            className="flex items-center gap-2 text-base text-muted-foreground"
          >
            <LoadingSwap isLoading>
              <RefreshCw className="size-4" aria-hidden="true" />
            </LoadingSwap>
            Loading study history…
          </div>
        )}
        {loadError && (
          <Alert role="alert">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              {loadError}
              <Button variant="outline" onClick={() => void reload()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!loading && !loadError && sessions.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {hasActiveFilters
                  ? 'No matching study sessions'
                  : 'No study sessions yet'}
              </EmptyTitle>
              <EmptyDescription className="text-base">
                {hasActiveFilters
                  ? 'Try another search or filter to find a saved session.'
                  : 'Your saved and in-progress sessions will appear here.'}
              </EmptyDescription>
            </EmptyHeader>
            {hasActiveFilters && (
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setCourseId(null);
                    setStatus(null);
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
        {sessions.length > 0 && (
          <ItemGroup aria-label="Saved study sessions" className="gap-2">
            {sessions.map((session) => {
              const activity = formatStudyActivity(session.activity);
              const sessionStatus = formatStudySessionStatus(session.status);
              const course = courses.find(
                (item) => item.id === session.courseId,
              );
              return (
                <Item
                  key={session.id}
                  role="listitem"
                  data-study-session-id={session.id}
                  variant="outline"
                  className="items-start gap-3 text-base"
                >
                  <ItemContent className="min-w-0 gap-2">
                    <ItemHeader className="items-start">
                      <div className="flex min-w-0 flex-col gap-1">
                        <ItemTitle className="text-base">
                          {session.title}
                        </ItemTitle>
                        <ItemActions className="flex-wrap text-muted-foreground">
                          <span className="flex items-center gap-2">
                            <activity.Icon
                              className="size-4 shrink-0"
                              aria-hidden="true"
                            />
                            {activity.label}
                          </span>
                          <span className="flex items-center gap-2">
                            <BookOpen
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            {course?.name ?? 'Course unavailable'}
                          </span>
                          <span className="flex items-center gap-2">
                            <sessionStatus.Icon
                              className="size-4 shrink-0"
                              aria-hidden="true"
                            />
                            {sessionStatus.label}
                          </span>
                          <time
                            dateTime={session.updatedAt}
                            className="flex items-center gap-2"
                            title={`Updated ${formatStudyUpdatedAt(session.updatedAt)}`}
                          >
                            <Clock3
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            Updated {formatStudyUpdatedAt(session.updatedAt)}
                          </time>
                        </ItemActions>
                        {session.topic && (
                          <FieldDescription className="line-clamp-2">
                            {session.topic}
                          </FieldDescription>
                        )}
                      </div>
                      <ItemActions className="shrink-0">
                        <TooltipWrapper content="Rename session">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Rename session: ${session.title}`}
                            disabled={offline}
                            onClick={() => openRename(session)}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                        </TooltipWrapper>
                        <TooltipWrapper content="Delete session">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete session: ${session.title}`}
                            disabled={offline}
                            onClick={() => {
                              setDeleteError(null);
                              confirmation.request(session);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </TooltipWrapper>
                        <Button
                          variant="outline"
                          aria-label={`Resume session: ${session.title}`}
                          onClick={() => void onResume(session.id)}
                        >
                          Resume
                        </Button>
                      </ItemActions>
                    </ItemHeader>
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        {loadMoreError && (
          <Alert role="alert">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              {loadMoreError}
              <Button variant="outline" onClick={() => void loadMore()}>
                Retry loading more
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {hasMore && !loadError && (
          <Button
            variant="outline"
            className="w-full"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => void loadMore()}
          >
            <LoadingSwap isLoading={loadingMore}>
              Load more sessions
            </LoadingSwap>
          </Button>
        )}
      </CardContent>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameTarget(null);
            setRenameError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename study session</DialogTitle>
            <RenameDialogDescription>
              Choose a short title you can find in your study history.
            </RenameDialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => void saveRename(event)}
          >
            <Field>
              <FieldLabel htmlFor="study-session-title">
                Session title
              </FieldLabel>
              <Input
                id="study-session-title"
                aria-label="Session title"
                value={renameTitle}
                maxLength={160}
                onChange={(event) => setRenameTitle(event.target.value)}
                aria-invalid={Boolean(renameError || !renameTitle.trim())}
                aria-describedby={
                  renameError
                    ? 'study-session-title-description study-session-title-error'
                    : 'study-session-title-description'
                }
                className="w-full text-base"
                autoFocus
              />
              <FieldDescription id="study-session-title-description">
                Enter a title up to 160 characters.
              </FieldDescription>
              {renameError && (
                <FieldError id="study-session-title-error">
                  {renameError}
                </FieldError>
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !renameTitle.trim()}>
                <LoadingSwap isLoading={renaming}>Rename session</LoadingSwap>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmation.pending !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            confirmation.cancel();
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this study session?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting removes the session transcript. Separately saved Context
              items, artifacts, memories, and learning observations stay
              available and can be removed separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <Alert role="alert">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void removeSession()}
            >
              <LoadingSwap isLoading={deleting}>Delete session</LoadingSwap>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
