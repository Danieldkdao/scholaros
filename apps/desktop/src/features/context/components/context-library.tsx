import { useEffect, useId, useRef, useState } from 'react';
import {
  contextKinds,
  ingestionStatuses,
} from '@scholaros/services/learning/context-contracts';
import type {
  ContextItemDTO,
  ContextKind,
  ContextPreview as ContextPreviewData,
  ContextProvenance,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';
import type { PreferenceContent } from '@scholaros/services/learning/memory-contracts';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@scholaros/ui/components/attachment';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@scholaros/ui/components/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
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
import { toast } from '@scholaros/ui/components/toast';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import {
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileImage,
  FileText,
  Image,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import { useConfirm } from '../../../hooks/use-confirm';
import { errorMessage } from '../../../lib/error-message';
import { ContextAddMenu } from './context-add-menu';
import { ContextItemDialog } from './context-item-dialog';
import { ContextPreview } from './context-preview';
import type {
  ContextCourse,
  ContextEventSubscription,
  ContextItemDetails,
  ContextLibraryApi,
} from '../hooks/use-context-library';
import { useContextLibrary } from '../hooks/use-context-library';

type ContextLibraryProps = {
  accountId: string | null;
  api: ContextLibraryApi;
  courses: ContextCourse[];
  refreshEpoch?: number;
  readOnly?: boolean;
  subscribeToEvents: ContextEventSubscription;
};

type ContextDialogMode = 'create-note' | 'edit-note' | 'preference';
type ImportOutcome = {
  itemId: string;
  operationId: string;
  status: IngestionStatus;
};
type FormattedContextState = {
  label: string;
  Icon: LucideIcon;
  attachmentState: 'idle' | 'processing' | 'error' | 'done';
};
type FormattedContextKind = { label: string; Icon: LucideIcon };
type FormattedContextProvenance = { label: string; Icon: LucideIcon };

const formatContextStatus = (
  status: IngestionStatus,
): FormattedContextState => {
  switch (status) {
    case 'queued':
      return {
        label: 'Waiting to read',
        Icon: Loader2,
        attachmentState: 'processing',
      };
    case 'processing':
      return { label: 'Reading', Icon: Loader2, attachmentState: 'processing' };
    case 'complete':
      return {
        label: 'Ready to use',
        Icon: CircleCheck,
        attachmentState: 'done',
      };
    case 'partial':
      return {
        label: 'Partially available',
        Icon: CircleAlert,
        attachmentState: 'idle',
      };
    case 'unreadable':
      return {
        label: 'Unreadable',
        Icon: CircleAlert,
        attachmentState: 'error',
      };
    case 'unsupported':
      return {
        label: 'Unsupported file',
        Icon: CircleAlert,
        attachmentState: 'error',
      };
    case 'failed':
      return {
        label: 'Could not read',
        Icon: CircleAlert,
        attachmentState: 'error',
      };
    case 'cancelled':
      return {
        label: 'Reading stopped',
        Icon: CircleAlert,
        attachmentState: 'error',
      };
  }
};

const formatContextKind = (kind: ContextKind): FormattedContextKind => {
  switch (kind) {
    case 'note':
      return { label: 'Note', Icon: FileText };
    case 'preference':
      return { label: 'Preference', Icon: Lightbulb };
    case 'document':
      return { label: 'Document', Icon: FileText };
    case 'image':
      return { label: 'Image', Icon: FileImage };
    case 'explanation':
      return { label: 'Explanation', Icon: Sparkles };
    case 'activity':
      return { label: 'Learning activity', Icon: BookOpenCheck };
  }
};

const formatContextProvenance = (
  provenance: ContextProvenance,
): FormattedContextProvenance => {
  switch (provenance) {
    case 'user-authored':
      return { label: 'Written by you', Icon: Pencil };
    case 'user-uploaded':
      return { label: 'Added by you', Icon: FileText };
    case 'connected-source':
      return { label: 'Connected course source', Icon: ExternalLink };
    case 'ai-generated':
      return { label: 'Created with ScholarOS', Icon: Sparkles };
  }
};

const getStatusMessage = (status: IngestionStatus) => {
  switch (status) {
    case 'queued':
      return 'This file is waiting to be read.';
    case 'processing':
      return 'This file is being read.';
    case 'complete':
      return 'The source is ready to use.';
    case 'partial':
      return 'Some content is available, but not every page could be interpreted.';
    case 'unreadable':
      return 'The source could not be read.';
    case 'unsupported':
      return 'This file type is not supported.';
    case 'failed':
      return 'The latest reading attempt did not finish.';
    case 'cancelled':
      return 'The latest reading attempt was stopped.';
  }
};

const ContextCourseSelect = ({
  item,
  courses,
  disabled,
  onChange,
}: {
  item: ContextItemDTO;
  courses: ContextCourse[];
  disabled: boolean;
  onChange: (courseId: string | null) => void;
}) => {
  const labelId = useId();
  const courseId = item.courseIds[0] ?? null;
  const selectedCourse = courses.find((course) => course.id === courseId);

  return (
    <div className="flex min-w-48 flex-col gap-2">
      <span id={labelId}>Course for {item.title}</span>
      <Select
        value={courseId}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value === 'string' || value === null) onChange(value);
        }}
      >
        <SelectTrigger aria-labelledby={labelId} className="w-full">
          <SelectValue placeholder="No course" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>No course</SelectItem>
          {courseId && !selectedCourse && (
            <SelectItem value={courseId}>Unavailable course</SelectItem>
          )}
          {courses.map((course) => (
            <SelectItem key={course.id} value={course.id}>
              {course.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

const ContextFilters = ({
  library,
  courses,
}: {
  library: ReturnType<typeof useContextLibrary>;
  courses: ContextCourse[];
}) => (
  <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
    <InputGroup className="lg:min-w-64 lg:flex-1">
      <InputGroupAddon>
        <InputGroupText>
          <Search aria-hidden="true" />
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search Context items"
        placeholder="Search your notes and files"
        maxLength={200}
        value={library.query}
        onChange={(event) => library.setQuery(event.target.value)}
      />
    </InputGroup>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex flex-col gap-2">
        <span id="context-kind-filter-label">Type</span>
        <Select
          value={library.kindFilter}
          onValueChange={(value) => {
            if (typeof value === 'string')
              library.setKindFilter(value as typeof library.kindFilter);
          }}
        >
          <SelectTrigger
            aria-labelledby="context-kind-filter-label"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {contextKinds.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {formatContextKind(kind).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span id="context-status-filter-label">Status</span>
        <Select
          value={library.statusFilter}
          onValueChange={(value) => {
            if (typeof value === 'string')
              library.setStatusFilter(value as typeof library.statusFilter);
          }}
        >
          <SelectTrigger
            aria-labelledby="context-status-filter-label"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ingestionStatuses.map((status) => (
              <SelectItem key={status} value={status}>
                {formatContextStatus(status).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span id="context-course-filter-label">Course</span>
        <p
          id="context-course-filter-help"
          className="text-base text-muted-foreground"
        >
          New files use this course, if any.
        </p>
        <Select
          value={library.courseFilter}
          onValueChange={(value) => {
            if (typeof value === 'string')
              library.setCourseFilter(value as typeof library.courseFilter);
          }}
        >
          <SelectTrigger
            aria-labelledby="context-course-filter-label"
            aria-describedby="context-course-filter-help"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All courses</SelectItem>
            <SelectItem value="unassigned">No course</SelectItem>
            {courses.map((course) => (
              <SelectItem key={course.id} value={`course:${course.id}`}>
                {course.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
);

export const ContextLibrary = ({
  accountId,
  api,
  courses,
  refreshEpoch = 0,
  readOnly = false,
  subscribeToEvents,
}: ContextLibraryProps) => {
  const library = useContextLibrary(
    accountId,
    api,
    subscribeToEvents,
    readOnly,
    refreshEpoch,
  );
  const [dialogMode, setDialogMode] = useState<ContextDialogMode | null>(null);
  const [editingItem, setEditingItem] = useState<ContextItemDTO | null>(null);
  const [editText, setEditText] = useState<string | undefined>();
  const [canEditText, setCanEditText] = useState(true);
  const [importOutcomes, setImportOutcomes] = useState<ImportOutcome[]>([]);
  const [importing, setImporting] = useState(false);
  const [linkingItemId, setLinkingItemId] = useState<string | null>(null);
  const [openingCourseId, setOpeningCourseId] = useState<string | null>(null);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<ContextItemDTO | null>(null);
  const [previewDetails, setPreviewDetails] =
    useState<ContextItemDetails | null>(null);
  const [previewCurrent, setPreviewCurrent] =
    useState<ContextPreviewData | null>(null);
  const [previewData, setPreviewData] = useState<ContextPreviewData | null>(
    null,
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRetrying, setPreviewRetrying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const confirmation = useConfirm<ContextItemDTO>();
  const accountRef = useRef(accountId);
  const readOnlyRef = useRef(readOnly);
  const operationScope = useRef(0);
  const previewRequest = useRef(0);
  const addMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogFinalFocus = useRef<HTMLElement | null>(null);
  const actionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const removalFinalFocus = useRef<HTMLElement | null>(null);
  if (accountRef.current !== accountId) {
    accountRef.current = accountId;
    operationScope.current += 1;
    previewRequest.current += 1;
  }
  readOnlyRef.current = readOnly;

  useEffect(() => {
    dialogFinalFocus.current = addMenuButtonRef.current;
    removalFinalFocus.current = addMenuButtonRef.current;
    setDialogMode(null);
    setEditingItem(null);
    setImportOutcomes([]);
    setImporting(false);
    setLinkingItemId(null);
    setOpeningCourseId(null);
    setRetryingItemId(null);
    setPreviewRetrying(false);
    setPreviewLoading(false);
    setRemoving(false);
    setRemovalError(null);
    setPreviewItem(null);
    setPreviewDetails(null);
    setPreviewCurrent(null);
    setPreviewData(null);
    setSelectedVersionId(null);
    setPreviewError(null);
    confirmation.cancel();
  }, [accountId]);

  useEffect(() => {
    if (!readOnly) return;
    setRemovalError(null);
    confirmation.cancel();
  }, [confirmation.cancel, readOnly]);

  const closeDialog = () => {
    setDialogMode(null);
    setEditingItem(null);
    setEditText(undefined);
    setCanEditText(true);
  };

  const openNote = () => {
    if (readOnlyRef.current || !accountId || accountRef.current !== accountId)
      return;
    dialogFinalFocus.current = addMenuButtonRef.current;
    setEditingItem(null);
    setEditText('');
    setCanEditText(true);
    setDialogMode('create-note');
  };

  const openPreference = () => {
    if (readOnlyRef.current || !accountId || accountRef.current !== accountId)
      return;
    dialogFinalFocus.current = addMenuButtonRef.current;
    setEditingItem(null);
    setDialogMode('preference');
  };

  const saveNote = async (input: {
    title: string;
    text?: string;
    courseId: string | null;
  }) => {
    const scope = operationScope.current;
    if (readOnlyRef.current)
      throw new Error('Reconnect online to save Context changes.');
    if (accountRef.current !== accountId)
      throw new Error('Your account changed. Reopen Context to save.');
    if (!accountId) throw new Error('Sign in to add Context.');
    if (editingItem) {
      await api.updateContextItem({
        itemId: editingItem.id,
        expectedRevision: editingItem.revision,
        title: input.title,
        ...(input.text === undefined ? {} : { text: input.text }),
        courseId: input.courseId,
      });
      if (scope !== operationScope.current) return;
      toast.success('Note updated');
    } else {
      await api.createContextNote({
        requestId: crypto.randomUUID(),
        title: input.title,
        text: input.text ?? '',
        kind: 'note',
        ...(input.courseId ? { courseId: input.courseId } : {}),
      });
      if (scope !== operationScope.current) return;
      toast.success('Note added to Context');
    }
    closeDialog();
    await library.reload();
  };

  const savePreference = async (input: {
    preference: PreferenceContent;
    courseId: string | null;
  }) => {
    const scope = operationScope.current;
    if (readOnlyRef.current)
      throw new Error('Reconnect online to save Context changes.');
    if (accountRef.current !== accountId)
      throw new Error('Your account changed. Reopen Context to save.');
    if (!accountId) throw new Error('Sign in to add a preference.');
    await api.upsertExplicitPreference({
      requestId: crypto.randomUUID(),
      preference: input.preference,
      ...(input.courseId ? { courseId: input.courseId } : {}),
    });
    if (scope !== operationScope.current) return;
    toast.success('Preference saved');
    closeDialog();
  };

  const importFiles = async () => {
    if (!accountId || accountRef.current !== accountId || readOnlyRef.current)
      return;
    const scope = operationScope.current;
    const courseId = library.courseFilter.startsWith('course:')
      ? library.courseFilter.slice('course:'.length)
      : undefined;
    setImporting(true);
    try {
      const result = await api.chooseContextFiles({
        ...(courseId ? { courseId } : {}),
        saveToLibrary: true,
      });
      if (scope !== operationScope.current || result.cancelled) return;
      setImportOutcomes((previous) => [
        ...result.items.map((entry) => ({ ...entry })),
        ...previous,
      ]);
      if (result.items.length > 0) {
        toast.success('Selected files for Context');
        await library.reload();
      }
    } catch (cause) {
      if (scope === operationScope.current)
        toast.error(errorMessage(cause, 'Could not add these files.'));
    } finally {
      if (scope === operationScope.current) setImporting(false);
    }
  };

  const openEdit = async (item: ContextItemDTO) => {
    dialogFinalFocus.current =
      actionButtonRefs.current.get(item.id) ?? addMenuButtonRef.current;
    if (
      !accountId ||
      accountRef.current !== accountId ||
      readOnlyRef.current ||
      item.kind !== 'note' ||
      item.provenance !== 'user-authored'
    )
      return;
    const scope = operationScope.current;
    try {
      const details = await api.getContextItem({ itemId: item.id });
      if (!details) throw new Error('Could not load this note.');
      if (scope !== operationScope.current || readOnlyRef.current) return;
      setEditingItem(details.item);
      setCanEditText(
        details.preview.kind === 'text' && !details.preview.partial,
      );
      setEditText(
        details.preview.kind === 'text' && !details.preview.partial
          ? details.preview.text
          : undefined,
      );
      setDialogMode('edit-note');
    } catch (cause) {
      if (scope === operationScope.current)
        toast.error(errorMessage(cause, 'Could not open this note.'));
    }
  };

  const openPreview = async (item: ContextItemDTO) => {
    if (!accountId || accountRef.current !== accountId) return;
    const request = ++previewRequest.current;
    const scope = operationScope.current;
    setPreviewItem(item);
    setPreviewDetails(null);
    setPreviewCurrent(null);
    setPreviewData(null);
    setSelectedVersionId(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const result = await api.getContextItem({ itemId: item.id });
      if (
        request !== previewRequest.current ||
        scope !== operationScope.current
      )
        return;
      if (!result) throw new Error('Could not load this source.');
      const nextDetails: ContextItemDetails = {
        item: result.item,
        versions: result.versions,
      };
      const latestVersion = [...result.versions].sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )[0];
      const selectedVersion =
        result.item.currentVersionId ?? latestVersion?.id ?? null;
      setPreviewItem(result.item);
      setPreviewDetails(nextDetails);
      setPreviewCurrent(result.preview);
      setSelectedVersionId(selectedVersion);
      if (selectedVersion && selectedVersion !== result.item.currentVersionId) {
        const historicalPreview = await api.readContextPreview({
          itemId: result.item.id,
          versionId: selectedVersion,
        });
        if (
          request !== previewRequest.current ||
          scope !== operationScope.current
        )
          return;
        if (!historicalPreview) throw new Error('Could not load this version.');
        setPreviewData(historicalPreview);
      } else setPreviewData(result.preview);
    } catch (cause) {
      if (
        request === previewRequest.current &&
        scope === operationScope.current
      ) {
        const message = errorMessage(cause, 'Could not load this preview.');
        setPreviewError(message);
        toast.error(message);
      }
    } finally {
      if (
        request === previewRequest.current &&
        scope === operationScope.current
      )
        setPreviewLoading(false);
    }
  };

  const changePreviewVersion = async (versionId: string) => {
    if (!previewDetails || !previewItem || accountRef.current !== accountId)
      return;
    const request = ++previewRequest.current;
    const scope = operationScope.current;
    setSelectedVersionId(versionId);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      if (versionId === previewDetails.item.currentVersionId) {
        setPreviewData(previewCurrent);
        return;
      }
      const historicalPreview = await api.readContextPreview({
        itemId: previewItem.id,
        versionId,
      });
      if (
        request !== previewRequest.current ||
        scope !== operationScope.current
      )
        return;
      if (!historicalPreview) throw new Error('Could not load this version.');
      setPreviewData(historicalPreview);
    } catch (cause) {
      if (
        request === previewRequest.current &&
        scope === operationScope.current
      ) {
        const message = errorMessage(cause, 'Could not load this version.');
        setPreviewError(message);
        toast.error(message);
      }
    } finally {
      if (
        request === previewRequest.current &&
        scope === operationScope.current
      )
        setPreviewLoading(false);
    }
  };

  const retryIngestion = async (item: ContextItemDTO) => {
    if (!accountId || accountRef.current !== accountId || readOnlyRef.current)
      return;
    const scope = operationScope.current;
    const previewRequestAtRetry = previewRequest.current;
    const refreshOpenPreview = previewItem?.id === item.id;
    setRetryingItemId(item.id);
    if (previewItem?.id === item.id) setPreviewRetrying(true);
    try {
      await api.retryContextIngestion({
        itemId: item.id,
        requestId: crypto.randomUUID(),
      });
      if (scope !== operationScope.current) return;
      toast.success('A new reading attempt has started');
      await library.reload();
      if (
        refreshOpenPreview &&
        previewRequestAtRetry === previewRequest.current &&
        scope === operationScope.current
      )
        await openPreview(item);
    } catch (cause) {
      if (scope === operationScope.current)
        toast.error(errorMessage(cause, 'Could not retry this file.'));
    } finally {
      if (scope === operationScope.current) {
        setRetryingItemId(null);
        setPreviewRetrying(false);
      }
    }
  };

  const changeCourse = async (
    item: ContextItemDTO,
    courseId: string | null,
  ) => {
    if (
      !accountId ||
      accountRef.current !== accountId ||
      readOnlyRef.current ||
      item.courseIds[0] === courseId
    )
      return;
    const scope = operationScope.current;
    setLinkingItemId(item.id);
    try {
      await api.linkContextItem({
        itemId: item.id,
        courseId,
        retainInLibrary: true,
      });
      if (scope !== operationScope.current) return;
      toast.success(
        courseId ? 'Course association updated' : 'Course detached',
      );
      await library.reload();
    } catch (cause) {
      if (scope === operationScope.current)
        toast.error(
          errorMessage(cause, 'Could not update the course association.'),
        );
    } finally {
      if (scope === operationScope.current) setLinkingItemId(null);
    }
  };

  const openCourse = async (course: ContextCourse) => {
    if (!accountId || accountRef.current !== accountId) return;
    const scope = operationScope.current;
    setOpeningCourseId(course.id);
    try {
      await api.openSource(course.url);
    } catch (cause) {
      if (scope === operationScope.current)
        toast.error(errorMessage(cause, 'Could not open this course.'));
    } finally {
      if (scope === operationScope.current) setOpeningCourseId(null);
    }
  };

  const requestRemoval = (item: ContextItemDTO) => {
    if (readOnlyRef.current || accountRef.current !== accountId) return;
    removalFinalFocus.current =
      actionButtonRefs.current.get(item.id) ?? addMenuButtonRef.current;
    setRemovalError(null);
    confirmation.request(item);
  };

  const removeItem = async () => {
    const item = confirmation.pending;
    if (
      !accountId ||
      accountRef.current !== accountId ||
      !item ||
      readOnlyRef.current
    )
      return;
    const scope = operationScope.current;
    setRemoving(true);
    setRemovalError(null);
    try {
      if (item.source?.sessionId) {
        await api.linkContextItem({
          itemId: item.id,
          courseId: item.courseIds[0] ?? null,
          sessionId: item.source.sessionId,
          retainInLibrary: false,
        });
      } else {
        await api.removeContextItem({
          itemId: item.id,
          expectedRevision: item.revision,
        });
      }
      if (scope !== operationScope.current) return;
      removalFinalFocus.current = addMenuButtonRef.current;
      confirmation.cancel();
      toast.success('Removed from Context');
      await library.reload();
    } catch (cause) {
      if (scope === operationScope.current) {
        const message = errorMessage(cause, 'Could not remove this item.');
        setRemovalError(message);
        toast.error(message);
      }
    } finally {
      if (scope === operationScope.current) setRemoving(false);
    }
  };

  const isUnfiltered =
    library.query.trim() === '' &&
    library.kindFilter === 'all' &&
    library.statusFilter === 'all' &&
    library.courseFilter === 'all';
  const emptyLibrary = library.items.length === 0 && isUnfiltered;
  const clearFilters = () => {
    library.setQuery('');
    library.setKindFilter('all');
    library.setStatusFilter('all');
    library.setCourseFilter('all');
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-6 text-base"
      aria-labelledby="context-library-title"
    >
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 id="context-library-title" className="text-2xl font-semibold">
            Context
          </h1>
          <p className="text-base text-muted-foreground">
            Keep notes and learning materials together, with their course and
            source details.
          </p>
          {readOnly && (
            <p role="status" className="text-base text-muted-foreground">
              Reconnect online to make Context changes.
            </p>
          )}
        </div>
        <ContextAddMenu
          disabled={!accountId || readOnly || importing}
          triggerRef={addMenuButtonRef}
          onCreateNote={openNote}
          onCreatePreference={openPreference}
          onImport={() => void importFiles()}
        />
      </header>
      <ContextFilters library={library} courses={courses} />
      {importOutcomes.length > 0 && (
        <section
          className="flex flex-col gap-3"
          aria-label="Recent import outcomes"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Recent imports</h2>
            <TooltipWrapper content="Dismiss import results">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss import results"
                onClick={() => setImportOutcomes([])}
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipWrapper>
          </div>
          <div className="flex flex-col gap-2">
            {importOutcomes.map((outcome, index) => {
              const importedItem = library.items.find(
                (entry) => entry.id === outcome.itemId,
              );
              const status = formatContextStatus(
                importedItem?.status ?? outcome.status,
              );
              return (
                <Attachment
                  key={`${outcome.operationId}-${outcome.itemId}`}
                  state={status.attachmentState}
                  className="w-full text-base"
                  aria-label={`${importedItem?.title ?? `File ${index + 1}`}: ${status.label}`}
                >
                  <AttachmentMedia>
                    <FileText aria-hidden="true" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle className="text-base">
                      {importedItem?.title ?? `File ${index + 1}`}
                    </AttachmentTitle>
                    <AttachmentDescription className="text-base">
                      {status.label}
                    </AttachmentDescription>
                  </AttachmentContent>
                </Attachment>
              );
            })}
          </div>
        </section>
      )}
      {importing && (
        <p
          role="status"
          aria-label="Opening file picker"
          className="flex items-center gap-2"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Opening the file picker
        </p>
      )}
      {library.loading && (
        <p
          role="status"
          aria-label="Loading your Context"
          className="flex items-center gap-2"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Loading your Context
        </p>
      )}
      {!library.loading && library.loadError && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            {library.loadError}
            <Button variant="outline" onClick={() => void library.reload()}>
              <LoadingSwap isLoading={library.loading}>Try again</LoadingSwap>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!accountId ? (
        <Empty className="text-base">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lightbulb aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Sign in to view Context</EmptyTitle>
            <EmptyDescription className="text-base">
              Your saved notes and materials are available after you reconnect.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !library.loading &&
        !library.loadError &&
        library.visibleItems.length === 0 ? (
        <Empty className="text-base">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {emptyLibrary ? (
                <Lightbulb aria-hidden="true" />
              ) : (
                <Search aria-hidden="true" />
              )}
            </EmptyMedia>
            <EmptyTitle>
              {emptyLibrary ? 'Your Context is empty' : 'No matching items'}
            </EmptyTitle>
            <EmptyDescription className="text-base">
              {emptyLibrary
                ? 'Add a note, preference, document, or image when it will help you learn.'
                : 'Try another search or filter to find your saved context.'}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {emptyLibrary ? (
              <Button disabled={readOnly} onClick={openNote}>
                Add a note
              </Button>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                {library.hasMore && (
                  <Button
                    variant="outline"
                    disabled={library.loadingMore}
                    onClick={library.loadMore}
                  >
                    <LoadingSwap isLoading={library.loadingMore}>
                      Load more
                    </LoadingSwap>
                  </Button>
                )}
                <Button variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            )}
          </EmptyContent>
        </Empty>
      ) : (
        <div
          className="flex min-w-0 flex-col gap-4"
          role="list"
          aria-label="Context items"
          aria-busy={library.loading || importing}
        >
          {library.visibleItems.map((item) => {
            const kind = formatContextKind(item.kind);
            const status = formatContextStatus(item.status);
            const provenance = formatContextProvenance(item.provenance);
            const course = courses.find(
              (entry) => entry.id === item.courseIds[0],
            );
            const editableNote =
              item.kind === 'note' && item.provenance === 'user-authored';
            const canRetry =
              (item.kind === 'document' || item.kind === 'image') &&
              item.status !== 'queued' &&
              item.status !== 'processing';
            return (
              <Card
                key={item.id}
                role="listitem"
                className="w-full min-w-0"
                data-context-item-id={item.id}
              >
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <Item className="min-w-0 flex-1 flex-nowrap border-0 p-0 text-base">
                    <ItemMedia variant="icon">
                      <kind.Icon aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full text-base">
                        <CardTitle className="truncate text-base">
                          {item.title}
                        </CardTitle>
                      </ItemTitle>
                      <ItemDescription className="text-base">
                        {getStatusMessage(item.status)}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  <ItemActions className="shrink-0">
                    <TooltipWrapper content={`Preview ${item.title}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Preview ${item.title}`}
                        onClick={() => void openPreview(item)}
                      >
                        <Search aria-hidden="true" />
                      </Button>
                    </TooltipWrapper>
                    {!readOnly && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              ref={(button) => {
                                if (button)
                                  actionButtonRefs.current.set(item.id, button);
                                else actionButtonRefs.current.delete(item.id);
                              }}
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${item.title}`}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {editableNote && (
                            <DropdownMenuItem
                              onClick={() => void openEdit(item)}
                            >
                              <Pencil aria-hidden="true" />
                              Edit note
                            </DropdownMenuItem>
                          )}
                          {canRetry && (
                            <DropdownMenuItem
                              disabled={retryingItemId === item.id}
                              onClick={() => void retryIngestion(item)}
                            >
                              <LoadingSwap
                                isLoading={retryingItemId === item.id}
                              >
                                <span className="flex items-center gap-2">
                                  <RefreshCw aria-hidden="true" />
                                  Try reading again
                                </span>
                              </LoadingSwap>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => requestRemoval(item)}
                          >
                            <Trash2 aria-hidden="true" />
                            Remove from Context
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </ItemActions>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-4">
                  {(item.kind === 'document' || item.kind === 'image') && (
                    <Attachment
                      state={status.attachmentState}
                      className="w-full text-base"
                    >
                      <AttachmentMedia>
                        {item.kind === 'image' ? (
                          <Image aria-hidden="true" />
                        ) : (
                          <FileText aria-hidden="true" />
                        )}
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle className="text-base">
                          {item.title}
                        </AttachmentTitle>
                        <AttachmentDescription className="text-base">
                          {status.label}
                        </AttachmentDescription>
                      </AttachmentContent>
                    </Attachment>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-base text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <kind.Icon aria-hidden="true" className="size-4" />
                      {kind.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <provenance.Icon aria-hidden="true" className="size-4" />
                      {provenance.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <status.Icon aria-hidden="true" className="size-4" />
                      {status.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <Clock3 aria-hidden="true" className="size-4" />
                      Updated {formatObservedAt(item.updatedAt)}
                    </span>
                  </div>
                  {item.usable && item.status !== 'complete' && (
                    <p className="flex items-center gap-2 text-base text-muted-foreground">
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      The last usable version is still available.
                    </p>
                  )}
                  {item.source?.removed && (
                    <Alert>
                      <CircleAlert aria-hidden="true" />
                      <AlertDescription>
                        This connected source was removed; saved history is kept
                        separate.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap items-end gap-3">
                    <ContextCourseSelect
                      item={item}
                      courses={courses}
                      disabled={readOnly || linkingItemId === item.id}
                      onChange={(courseId) => void changeCourse(item, courseId)}
                    />
                    {course && (
                      <TooltipWrapper content={`Open ${course.name}`}>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label={`Open ${course.name}`}
                          disabled={openingCourseId === course.id}
                          onClick={() => void openCourse(course)}
                        >
                          <LoadingSwap
                            isLoading={openingCourseId === course.id}
                          >
                            <ExternalLink aria-hidden="true" />
                          </LoadingSwap>
                        </Button>
                      </TooltipWrapper>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {library.loadMoreError && (
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{library.loadMoreError}</AlertDescription>
            </Alert>
          )}
          {library.hasMore && (
            <Button
              variant="outline"
              className="self-center"
              disabled={library.loadingMore}
              onClick={library.loadMore}
            >
              <LoadingSwap isLoading={library.loadingMore}>
                Load more
              </LoadingSwap>
            </Button>
          )}
          {!library.hasMore && library.items.length > 0 && (
            <p className="text-base text-muted-foreground">
              {library.items.length} saved{' '}
              {library.items.length === 1 ? 'item' : 'items'}
            </p>
          )}
        </div>
      )}
      {dialogMode === 'preference' ? (
        <ContextItemDialog
          mode="preference"
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          finalFocus={dialogFinalFocus}
          courses={courses}
          readOnly={readOnly}
          onSave={savePreference}
        />
      ) : (
        dialogMode && (
          <ContextItemDialog
            mode="note"
            open
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
            finalFocus={dialogFinalFocus}
            courses={courses}
            readOnly={readOnly}
            item={
              dialogMode === 'edit-note'
                ? (editingItem ?? undefined)
                : undefined
            }
            initialText={editText}
            canEditText={canEditText}
            onSave={saveNote}
          />
        )
      )}
      <ContextPreview
        open={!!previewItem}
        onOpenChange={(open) => {
          if (!open) {
            previewRequest.current += 1;
            setPreviewItem(null);
            setPreviewDetails(null);
            setPreviewCurrent(null);
            setPreviewData(null);
            setPreviewError(null);
          }
        }}
        details={previewDetails}
        selectedVersionId={selectedVersionId}
        preview={previewError ? null : previewData}
        loading={previewLoading}
        retrying={previewRetrying}
        readOnly={readOnly}
        onVersionChange={(versionId) => void changePreviewVersion(versionId)}
        onRetry={() => {
          if (previewItem) void retryIngestion(previewItem);
        }}
      />
      {previewError && (
        <p role="status" className="sr-only">
          {previewError}
        </p>
      )}
      <AlertDialog
        open={!!confirmation.pending && !readOnly}
        onOpenChange={(open) => {
          if (!open && !removing) {
            confirmation.cancel();
            setRemovalError(null);
          }
        }}
      >
        <AlertDialogContent finalFocus={removalFinalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {confirmation.pending?.title ?? 'this item'} from Context?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation.pending?.source?.sessionId
                ? 'This removes it from Context but keeps its session copy and existing citations.'
                : 'It will leave future Context search; existing citations may show as historical or removed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removalError && (
            <p role="alert" className="text-base text-destructive">
              {removalError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={readOnly || removing}
              onClick={() => void removeItem()}
            >
              <LoadingSwap isLoading={removing}>Remove</LoadingSwap>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
