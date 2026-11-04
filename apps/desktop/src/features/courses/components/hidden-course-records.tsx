import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
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
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { toast } from '@scholaros/ui/components/toast';
import { useConfirm } from '../../../hooks/use-confirm';
import { errorMessage } from '../../../lib/error-message';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import { formatCourseRecordKind } from '../lib/formatters';
import type {
  ListCourseRecordSuppressionsSchema,
  RestoreCourseRecordSuppressionSchema,
} from '../schemas';
import type { CourseRecordSuppressionView } from '../services/store';

type CourseSuppressionBridge = {
  listCourseRecordSuppressions?: (
    input: ListCourseRecordSuppressionsSchema,
  ) => Promise<CourseRecordSuppressionView[] | null>;
  restoreCourseRecordSuppression?: (
    input: RestoreCourseRecordSuppressionSchema,
  ) => Promise<void>;
};

type HiddenCourseRecordsProps = {
  courseId?: string;
  courseTitle?: string;
  connectionId?: string | null;
  restoreDisabled?: boolean;
  onRestored?: () => void;
  listSuppressions?: (
    input: ListCourseRecordSuppressionsSchema,
  ) => Promise<CourseRecordSuppressionView[] | null>;
  restoreSuppression?: (
    input: RestoreCourseRecordSuppressionSchema,
  ) => Promise<void>;
};

const pageSize = 50;

const readSuppressionPage = async (
  input: ListCourseRecordSuppressionsSchema,
  listSuppressions?: HiddenCourseRecordsProps['listSuppressions'],
) => {
  const list =
    listSuppressions ??
    (window.scholar as typeof window.scholar & CourseSuppressionBridge)
      .listCourseRecordSuppressions;
  if (!list) throw new Error('Hidden records are not available yet.');
  const suppressions = await list(input);
  if (!suppressions) throw new Error('Could not load hidden records.');
  return suppressions;
};

const restoreSuppression = async (
  input: RestoreCourseRecordSuppressionSchema,
  restore?: HiddenCourseRecordsProps['restoreSuppression'],
) => {
  const restoreRecord =
    restore ??
    (window.scholar as typeof window.scholar & CourseSuppressionBridge)
      .restoreCourseRecordSuppression;
  if (!restoreRecord)
    throw new Error('Restoring hidden records is not available yet.');
  await restoreRecord(input);
};

const formatSuppressionKind = (suppression: CourseRecordSuppressionView) => {
  const kind = formatCourseRecordKind(suppression.kind);
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
};

const formatSuppressionPluralKind = (
  kind: CourseRecordSuppressionView['kind'],
) => {
  switch (kind) {
    case 'courses':
      return 'courses';
    case 'assignments':
      return 'assignments';
    case 'announcements':
      return 'announcements';
  }
};

export const HiddenCourseRecords = ({
  courseId,
  courseTitle,
  connectionId,
  restoreDisabled = false,
  onRestored,
  listSuppressions,
  restoreSuppression: restoreCallback,
}: HiddenCourseRecordsProps) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [suppressions, setSuppressions] = useState<
    CourseRecordSuppressionView[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const confirmation = useConfirm<CourseRecordSuppressionView>();
  const restoreRequest = confirmation.pending;
  const triggerLabel = courseId
    ? `Hidden records for ${courseTitle ?? 'this course'}`
    : 'Hidden course records';

  const readPage = useCallback(
    (cursor?: string) =>
      readSuppressionPage(
        {
          ...(connectionId ? { connectionId } : {}),
          ...(courseId ? { courseId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: pageSize,
        },
        listSuppressions,
      ),
    [connectionId, courseId, listSuppressions],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setSuppressions([]);
    setError(null);
    setHasMore(false);
    void readPage()
      .then((records) => {
        if (cancelled) return;
        setSuppressions(records);
        setHasMore(records.length === pageSize);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause, 'Could not load hidden records.'));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevision, open, readPage]);

  const loadMore = async () => {
    const cursor = suppressions.at(-1)?.suppressionId;
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const records = await readPage(cursor);
      setSuppressions((existing) => [...existing, ...records]);
      setHasMore(records.length === pageSize);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not load more hidden records.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const restore = async (suppression: CourseRecordSuppressionView) => {
    setRestoringId(suppression.suppressionId);
    setError(null);
    try {
      await restoreSuppression(suppression.restoreInput, restoreCallback);
      confirmation.cancel();
      toast.success('Records restored');
      onRestored?.();
      try {
        const records = await readPage();
        setSuppressions(records);
        setHasMore(records.length === pageSize);
      } catch {
        setError(
          'Records were restored, but this list could not refresh. Close and reopen it.',
        );
      }
    } catch (cause) {
      const message = errorMessage(cause, 'Could not restore these records.');
      setError(message);
      toast.error(message);
    } finally {
      setRestoringId(null);
    }
  };

  const closeConfirmation = (nextOpen: boolean) => {
    if (!nextOpen && !restoringId) confirmation.cancel();
  };

  return (
    <>
      <TooltipWrapper content={triggerLabel}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={triggerLabel}
          onClick={() => setOpen(true)}
        >
          <RotateCcw />
        </Button>
      </TooltipWrapper>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hidden records</DialogTitle>
            <DialogDescription>
              Restoring only changes local visibility; it does not reconnect to
              or read your source.
            </DialogDescription>
          </DialogHeader>
          {restoreDisabled && (
            <p className="text-base text-muted-foreground" role="status">
              Stop the course refresh before restoring records.
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {status === 'loading' && (
            <div className="flex items-center gap-2" aria-busy="true">
              <span className="sr-only">Loading hidden records</span>
              <LoadingSwap isLoading>
                <span>Loading hidden records</span>
              </LoadingSwap>
            </div>
          )}
          {status === 'error' && (
            <Button
              variant="outline"
              onClick={() => setLoadRevision((revision) => revision + 1)}
            >
              Try again
            </Button>
          )}
          {status === 'ready' && suppressions.length === 0 && (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>No hidden records</EmptyTitle>
                <EmptyDescription className="text-base">
                  Records you hide from this course will appear here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {status === 'ready' && suppressions.length > 0 && (
            <ItemGroup aria-label="Hidden course records">
              {suppressions.map((suppression) => {
                const isRestoring = restoringId === suppression.suppressionId;
                const kind = formatSuppressionKind(suppression);
                return (
                  <Item
                    key={suppression.suppressionId}
                    role="listitem"
                    variant="outline"
                    size="sm"
                  >
                    <ItemMedia variant="icon" aria-hidden="true">
                      <RotateCcw />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="text-base">
                        {suppression.title}
                      </ItemTitle>
                      <ItemDescription className="text-base">
                        {suppression.legacy
                          ? `Legacy ${kind.toLowerCase()}; restoring applies to the full source scope.`
                          : `${kind}${suppression.context ? ` in ${suppression.context}` : ''} hidden ${formatObservedAt(suppression.hiddenAt)}`}
                      </ItemDescription>
                      {suppression.legacy && (
                        <ItemDescription className="text-base">
                          Previously deleted local records cannot be recovered.
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={restoreDisabled || !!restoringId}
                        onClick={() => {
                          if (suppression.legacy)
                            confirmation.request(suppression);
                          else void restore(suppression);
                        }}
                      >
                        <LoadingSwap isLoading={isRestoring}>
                          {suppression.legacy ? 'Restore scope' : 'Restore'}
                        </LoadingSwap>
                      </Button>
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
          {hasMore && status === 'ready' && (
            <Button
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              <LoadingSwap isLoading={loadingMore}>Load more</LoadingSwap>
            </Button>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Close
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!restoreRequest} onOpenChange={closeConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore all legacy hidden{' '}
              {restoreRequest
                ? formatSuppressionPluralKind(restoreRequest.kind)
                : 'records'}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This is a scope-wide restore for{' '}
              {restoreRequest?.context ?? 'this source'}. Previously deleted
              local records cannot be recovered, and this will not reconnect to
              or read the source.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!restoringId}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={restoreDisabled || !!restoringId || !restoreRequest}
              onClick={() => {
                if (restoreRequest) void restore(restoreRequest);
              }}
            >
              <LoadingSwap isLoading={!!restoringId}>Restore all</LoadingSwap>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
