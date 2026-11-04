import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { BookOpen, Pencil, Trash2, X } from 'lucide-react';
import {
  memoryTypes,
  type MemoryDTO,
} from '@scholaros/services/learning/memory-contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@scholaros/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import { Badge } from '@scholaros/ui/components/badge';
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@scholaros/ui/components/field';
import { Input } from '@scholaros/ui/components/input';
import { FilterPopover } from '@scholaros/ui/components/filter-popover';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
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
import { Skeleton } from '@scholaros/ui/components/skeleton';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useConfirm } from '../../../hooks/use-confirm';
import { useCourses } from '../../courses/hooks/use-courses';
import { errorMessage } from '../../../lib/error-message';
import { MemoryEditor } from './memory-editor';
import {
  formatEvidenceCount,
  formatMemoryContent,
  formatMemoryProvenance,
  formatMemoryScope,
  formatMemoryType,
} from '../lib/formatters';
import { useMemory } from '../hooks/use-memory';

type MemoryPanelProps = { accountId: string; courseId?: string };

type MemoryFilterType = 'all' | MemoryDTO['type'];

const isEditablePreference = (memory: MemoryDTO) =>
  memory.type !== 'learning-observation' && 'field' in memory.content;

const MemoryPanelContent = ({ accountId, courseId }: MemoryPanelProps) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const [typeFilter, setTypeFilter] = useState<MemoryFilterType>('all');
  const [courseFilter, setCourseFilter] = useState(courseId ?? 'all');
  const [editingMemory, setEditingMemory] = useState<MemoryDTO | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const {
    pending: pendingDelete,
    request: requestDelete,
    cancel: cancelDelete,
  } = useConfirm<MemoryDTO>();
  const cancelDeleteRef = useRef(cancelDelete);
  cancelDeleteRef.current = cancelDelete;
  const courseState = useCourses(accountId);
  const memoryState = useMemory(accountId, {
    query: debouncedQuery,
    ...(typeFilter === 'all' ? {} : { type: typeFilter }),
    ...(courseId
      ? { courseId }
      : courseFilter === 'all'
        ? {}
        : { courseId: courseFilter }),
  });

  useEffect(() => {
    setCourseFilter(courseId ?? 'all');
    setEditingMemory(null);
    cancelDeleteRef.current();
    setDeleteError(null);
  }, [accountId, courseId]);

  const courseNameFor = (id: string | null) =>
    id === null
      ? null
      : (courseState.snapshot?.courses.find((course) => course.id === id)
          ?.name ?? null);

  const deleteMemory = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await memoryState.remove({
        memoryId: pendingDelete.id,
        expectedRevision: pendingDelete.revision,
      });
      cancelDelete();
    } catch (cause) {
      setDeleteError(errorMessage(cause, 'Could not delete this memory.'));
    } finally {
      setDeleting(false);
    }
  };

  const statusAlert =
    memoryState.status === 'error' || memoryState.status === 'offline';
  const loadLabel =
    memoryState.status === 'offline'
      ? 'Remembered information is unavailable offline.'
      : memoryState.items.length > 0
        ? 'Could not load more remembered information.'
        : 'Could not load remembered information.';
  const hasNoMemories =
    memoryState.status === 'ready' && memoryState.items.length === 0;
  const hasActiveFilters =
    !!debouncedQuery ||
    typeFilter !== 'all' ||
    (!courseId && courseFilter !== 'all');

  return (
    <>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>
            <h2 className="text-xl font-semibold">Remembered information</h2>
          </CardTitle>
          <CardDescription>
            Review preferences and learning notes used to personalize future
            sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="flex w-full min-w-0 flex-row items-end gap-3">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="memory-search">
                Search remembered information
              </FieldLabel>
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                <Input
                  id="memory-search"
                  aria-label="Search remembered information"
                  autoComplete="off"
                  maxLength={200}
                  placeholder="Search memories"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                <TooltipWrapper content="Clear search">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Clear memory search"
                    disabled={!query}
                    onClick={() => setQuery('')}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </TooltipWrapper>
              </div>
            </Field>
            <FilterPopover label="Remembered information filters">
              <div className="flex flex-col gap-4">
                <Field>
                  <FieldLabel id="memory-type-label">Type</FieldLabel>
                  <Select
                    value={typeFilter}
                    onValueChange={(nextValue) => {
                      if (nextValue === 'all') setTypeFilter('all');
                      else {
                        const selectedType = memoryTypes.find(
                          (memoryType) => memoryType === nextValue,
                        );
                        if (selectedType) setTypeFilter(selectedType);
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-label="Filter memories by type"
                      aria-labelledby="memory-type-label"
                      className="w-full"
                    >
                      <SelectValue>
                        {typeFilter === 'all'
                          ? 'All memory types'
                          : formatMemoryType(typeFilter).label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All memory types</SelectItem>
                      {memoryTypes.map((memoryType) => (
                        <SelectItem key={memoryType} value={memoryType}>
                          {formatMemoryType(memoryType).label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {courseId ? (
                  <Field>
                    <FieldLabel>Course scope</FieldLabel>
                    <div className="flex min-h-9 items-center gap-2 text-base">
                      <BookOpen aria-hidden="true" className="size-4" />
                      <span>
                        {courseNameFor(courseId) ?? 'Course-specific'}
                      </span>
                    </div>
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel id="memory-course-label">Course</FieldLabel>
                    <Select
                      value={courseFilter}
                      onValueChange={(nextValue) => {
                        if (typeof nextValue === 'string')
                          setCourseFilter(nextValue);
                      }}
                    >
                      <SelectTrigger
                        aria-label="Filter memories by course"
                        aria-labelledby="memory-course-label"
                        className="w-full"
                      >
                        <SelectValue>
                          {courseFilter === 'all'
                            ? 'All courses'
                            : (courseNameFor(courseFilter) ??
                              'Unavailable course')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All courses</SelectItem>
                        {courseState.snapshot?.courses.map((course) => (
                          <SelectItem key={course.id} value={course.id}>
                            {course.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </div>
            </FilterPopover>
          </FieldGroup>
          {statusAlert && (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>{loadLabel}</AlertTitle>
              <AlertDescription>
                {memoryState.error ?? loadLabel}
                <Button
                  className="mt-2 w-full sm:w-fit"
                  type="button"
                  variant="outline"
                  onClick={() => void memoryState.reload()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {memoryState.status === 'loading' && (
            <div
              aria-busy="true"
              aria-label="Loading remembered information"
              className="mt-4 flex flex-col gap-3"
              role="status"
            >
              <Skeleton className="h-20 w-full motion-reduce:animate-none" />
              <Skeleton className="h-20 w-full motion-reduce:animate-none" />
            </div>
          )}
          {hasNoMemories && (
            <Empty className="mt-4 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpen aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle role="heading" aria-level={3}>
                  No matching memories
                </EmptyTitle>
                <EmptyDescription className="text-base">
                  {debouncedQuery
                    ? 'Try a shorter search or choose another filter.'
                    : 'Preferences and learning observations will appear here when they are saved.'}
                </EmptyDescription>
              </EmptyHeader>
              {hasActiveFilters && (
                <EmptyContent>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setQuery('');
                      setTypeFilter('all');
                      if (!courseId) setCourseFilter('all');
                    }}
                  >
                    Clear filters
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
          {memoryState.items.length > 0 && (
            <ItemGroup className="mt-4">
              {memoryState.items.map((memory) => {
                const type = formatMemoryType(memory.type);
                const provenance = formatMemoryProvenance(memory.provenance);
                const content = formatMemoryContent(memory);
                const scope = formatMemoryScope(
                  memory.courseId,
                  courseNameFor(memory.courseId),
                );
                return (
                  <Item
                    key={memory.id}
                    role="listitem"
                    variant="outline"
                    className="items-start text-base"
                  >
                    <ItemContent className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ItemTitle
                          role="heading"
                          aria-level={3}
                          className="text-base"
                        >
                          {content.title}
                        </ItemTitle>
                        <Badge variant="outline" className="h-auto text-base">
                          <type.Icon aria-hidden="true" />
                          {type.label}
                        </Badge>
                      </div>
                      <ItemDescription className="line-clamp-none text-base">
                        {content.description}
                      </ItemDescription>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="h-auto text-base">
                          <provenance.Icon aria-hidden="true" />
                          {provenance.label}
                        </Badge>
                        <Badge variant="outline" className="h-auto text-base">
                          <scope.Icon aria-hidden="true" />
                          {scope.label}
                        </Badge>
                        {memory.evidenceIds.length > 0 && (
                          <span className="text-base text-muted-foreground">
                            {formatEvidenceCount(memory.evidenceIds.length)}
                          </span>
                        )}
                      </div>
                    </ItemContent>
                    <ItemActions className="self-start">
                      {isEditablePreference(memory) && (
                        <TooltipWrapper content={`Edit ${content.title}`}>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${content.title}`}
                            onClick={() => setEditingMemory(memory)}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                        </TooltipWrapper>
                      )}
                      <TooltipWrapper content={`Delete ${content.title}`}>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${content.title}`}
                          onClick={() => {
                            setDeleteError(null);
                            requestDelete(memory);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </TooltipWrapper>
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
          {memoryState.nextCursor && (
            <Button
              className="mt-4 w-full sm:w-fit"
              type="button"
              variant="outline"
              disabled={memoryState.status === 'loading-more'}
              aria-busy={memoryState.status === 'loading-more'}
              aria-label={
                memoryState.status === 'loading-more'
                  ? 'Loading more memories'
                  : 'Load more memories'
              }
              onClick={() => void memoryState.loadMore()}
            >
              <LoadingSwap isLoading={memoryState.status === 'loading-more'}>
                Load more memories
              </LoadingSwap>
            </Button>
          )}
        </CardContent>
      </Card>
      {editingMemory && (
        <MemoryEditor
          memory={editingMemory}
          onCancel={() => setEditingMemory(null)}
          onSave={async (input) => {
            await memoryState.correct(input);
          }}
        />
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) cancelDelete();
        }}
      >
        <AlertDialogContent className="motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete remembered information?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the memory from future study context without deleting
              its source or transcript.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} onClick={cancelDelete}>
              Keep memory
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              aria-busy={deleting}
              aria-label={deleting ? 'Deleting memory' : 'Delete memory'}
              onClick={(event) => {
                event.preventDefault();
                void deleteMemory();
              }}
            >
              <LoadingSwap isLoading={deleting}>Delete memory</LoadingSwap>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export const MemoryPanel = ({ accountId, courseId }: MemoryPanelProps) => (
  <MemoryPanelContent
    key={accountId}
    accountId={accountId}
    courseId={courseId}
  />
);
