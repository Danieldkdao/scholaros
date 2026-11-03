import { useEffect, useRef, useState } from 'react';
import {
  BanIcon,
  BookOpenTextIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  HistoryIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import type {
  ContextPreview,
  ContextProvenance,
  Locator,
  SourceKind,
  SourceReference,
} from '@scholaros/services/learning/context-contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import { Button } from '@scholaros/ui/components/button';
import { cn } from '@scholaros/ui/lib/utils';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { toast } from '@scholaros/ui/components/toast';

type SourceStatusPresentation = {
  label: string;
  Icon: typeof CircleCheckIcon;
  canPreview: boolean;
  canOpen: boolean;
};
export type StudySourcePreview = {
  reference: SourceReference;
  preview: ContextPreview;
};
export type StudySourcePanelProps = {
  sessionId: string;
  open: boolean;
  references: SourceReference[];
  selectedReference: SourceReference | null;
  gradeContentVisible: boolean;
  readSourcePreview?: (
    sessionId: string,
    reference: SourceReference,
  ) => Promise<StudySourcePreview | null>;
  openSource?: (sessionId: string, reference: SourceReference) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSelectReference: (reference: SourceReference) => void;
};

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; result: StudySourcePreview }
  | {
      status: 'unavailable';
      key: string;
      message: string;
      reference?: SourceReference;
      blocksOpening?: boolean;
    };

const sourceReferenceKey = (reference: SourceReference) =>
  [
    reference.sourceKind,
    reference.sourceId,
    reference.courseId ?? '',
    reference.versionId ?? '',
    reference.locator ? JSON.stringify(reference.locator) : '',
  ].join(':');

const sourcePreviewKey = (reference: SourceReference) =>
  `${sourceReferenceKey(reference)}:${reference.state}:${reference.observedAt ?? ''}`;

const formatSourceState = (
  state: SourceReference['state'],
): SourceStatusPresentation => {
  switch (state) {
    case 'current':
      return {
        label: 'Current source',
        Icon: CircleCheckIcon,
        canPreview: true,
        canOpen: true,
      };
    case 'historical':
      return {
        label: 'Historical version',
        Icon: HistoryIcon,
        canPreview: true,
        canOpen: false,
      };
    case 'removed':
      return {
        label: 'Source removed',
        Icon: BanIcon,
        canPreview: false,
        canOpen: false,
      };
    case 'unavailable':
      return {
        label: 'Source unavailable',
        Icon: CircleHelpIcon,
        canPreview: false,
        canOpen: false,
      };
  }
};

const formatSourceKind = (kind: SourceKind) => {
  switch (kind) {
    case 'course-material':
      return 'Course material';
    case 'context-version':
      return 'Context item';
    case 'assignment':
      return 'Assignment';
    case 'announcement':
      return 'Announcement';
    case 'saved-activity':
      return 'Saved activity';
    case 'grade-evidence':
      return 'Grade feedback';
  }
};

const formatSourceProvenance = (provenance: ContextProvenance) => {
  switch (provenance) {
    case 'user-authored':
      return 'Written in ScholarOS';
    case 'user-uploaded':
      return 'Uploaded by you';
    case 'connected-source':
      return 'Connected course source';
    case 'ai-generated':
      return 'Created with ScholarOS';
  }
};

const formatLocator = (locator: Locator | null) => {
  if (!locator) return null;
  switch (locator.kind) {
    case 'page':
      return `Page ${locator.page}`;
    case 'heading':
      return `Heading: ${locator.heading}`;
    case 'paragraph':
      return `Paragraph ${locator.ordinal}`;
  }
};

const formatObservedAt = (observedAt: string | null) => {
  if (!observedAt) return null;
  const instant = new Date(observedAt);
  if (Number.isNaN(instant.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
};

const formatPreviewError = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch (error.code) {
      case 'offline':
        return 'Source inspection is unavailable offline.';
      case 'scope-denied':
      case 'permission-revoked':
        return 'This source is no longer available to this session.';
      case 'session-changed':
        return 'This session changed before the source could be opened.';
      case 'removed':
        return 'This source was removed and can no longer be previewed.';
      default:
        break;
    }
  }
  return 'This source could not be inspected right now.';
};

const SourcePreviewContent = ({
  result,
  title,
}: {
  result: StudySourcePreview;
  title: string;
}) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageUnavailable, setImageUnavailable] = useState(false);
  const { preview, reference } = result;

  useEffect(() => {
    if (preview.kind !== 'image') {
      setImageUrl(null);
      setImageUnavailable(false);
      return;
    }
    try {
      const objectUrl = URL.createObjectURL(
        new Blob([preview.bytes], { type: preview.mimeType }),
      );
      setImageUrl(objectUrl);
      setImageUnavailable(false);
      return () => URL.revokeObjectURL(objectUrl);
    } catch {
      setImageUrl(null);
      setImageUnavailable(true);
    }
  }, [preview]);

  if (reference.state === 'removed') {
    return (
      <p className="text-base text-muted-foreground" role="status">
        This source was removed. Its content is not available in this session.
      </p>
    );
  }
  if (preview.kind === 'unavailable') {
    return (
      <p className="text-base text-muted-foreground" role="status">
        Preview unavailable: {preview.reason.replaceAll('-', ' ')}.
      </p>
    );
  }
  if (preview.kind === 'text') {
    return (
      <div className="flex flex-col gap-2">
        {preview.partial && (
          <p className="text-base text-muted-foreground">
            This is a partial source preview.
          </p>
        )}
        {preview.uncertainty && (
          <p className="text-base text-muted-foreground">
            {preview.uncertainty}
          </p>
        )}
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-base">
          {preview.text}
        </pre>
      </div>
    );
  }
  if (imageUnavailable) {
    return (
      <p className="text-base text-muted-foreground" role="status">
        Image preview is unavailable in this build.
      </p>
    );
  }
  return imageUrl ? (
    <img
      alt={`Preview of ${title}`}
      className="max-h-72 max-w-full rounded-md object-contain"
      src={imageUrl}
      width={preview.width}
      height={preview.height}
    />
  ) : (
    <p className="text-base text-muted-foreground" role="status">
      Loading image preview
    </p>
  );
};

export const StudySourcePanel = ({
  sessionId,
  open,
  references,
  selectedReference,
  gradeContentVisible,
  readSourcePreview,
  openSource,
  onOpenChange,
  onSelectReference,
}: StudySourcePanelProps) => {
  const [previewState, setPreviewState] = useState<PreviewState>({
    status: 'idle',
  });
  const [openError, setOpenError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const currentOpenKeyRef = useRef<string | null>(null);
  const visibleReferences = references.filter(
    (reference) =>
      gradeContentVisible || reference.sourceKind !== 'grade-evidence',
  );
  const selected =
    (selectedReference
      ? visibleReferences.find(
          (reference) =>
            sourceReferenceKey(reference) ===
            sourceReferenceKey(selectedReference),
        )
      : undefined) ??
    visibleReferences[0] ??
    null;
  const previewMatchesSelection =
    selected !== null &&
    previewState.status !== 'idle' &&
    previewState.key === sourcePreviewKey(selected);
  const resolvedReference =
    previewMatchesSelection && previewState.status === 'ready'
      ? previewState.result.reference
      : previewMatchesSelection &&
          previewState.status === 'unavailable' &&
          previewState.reference
        ? previewState.reference
        : selected;
  const currentOpenKey = resolvedReference
    ? `${sessionId}:${sourcePreviewKey(resolvedReference)}`
    : null;
  currentOpenKeyRef.current = currentOpenKey;
  const opening = currentOpenKey !== null && openingKey === currentOpenKey;
  const visibleOpenError =
    openError?.key === currentOpenKey ? openError.message : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open || !selected) {
      setPreviewState({ status: 'idle' });
      setOpenError(null);
      return;
    }
    setOpenError(null);
    const state = formatSourceState(selected.state);
    const key = sourcePreviewKey(selected);
    if (!state.canPreview || !readSourcePreview) {
      setPreviewState({
        status: 'unavailable',
        key,
        message: state.canPreview
          ? 'Source preview is unavailable in this build.'
          : selected.state === 'removed'
            ? 'This source was removed and its content is not available.'
            : 'This source could not be verified and cannot be previewed.',
      });
      return;
    }
    let active = true;
    setPreviewState({ status: 'loading', key });
    void readSourcePreview(sessionId, selected)
      .then((result) => {
        if (!active) return;
        if (
          !result ||
          result.reference.sourceKind !== selected.sourceKind ||
          result.reference.sourceId !== selected.sourceId ||
          result.reference.courseId !== selected.courseId ||
          (selected.versionId !== null &&
            result.reference.versionId !== selected.versionId) ||
          JSON.stringify(result.reference.locator) !==
            JSON.stringify(selected.locator)
        ) {
          setPreviewState({
            status: 'unavailable',
            key,
            message:
              'The source version could not be verified for this session.',
            blocksOpening: true,
          });
          return;
        }
        if (
          result.reference.state === 'removed' ||
          result.reference.state === 'unavailable'
        ) {
          setPreviewState({
            status: 'unavailable',
            key,
            message:
              result.reference.state === 'removed'
                ? 'This source was removed and can no longer be previewed.'
                : 'This source could not be verified and cannot be previewed.',
            reference: result.reference,
            blocksOpening: true,
          });
          return;
        }
        setPreviewState({ status: 'ready', key, result });
      })
      .catch((error: unknown) => {
        if (active)
          setPreviewState({
            status: 'unavailable',
            key,
            message: formatPreviewError(error),
          });
      });
    return () => {
      active = false;
    };
  }, [open, selected, sessionId, readSourcePreview]);

  const openSelectedSource = async () => {
    if (
      !resolvedReference ||
      resolvedReference.state !== 'current' ||
      !openSource ||
      !currentOpenKey ||
      (previewMatchesSelection &&
        previewState.status === 'unavailable' &&
        previewState.blocksOpening) ||
      opening
    )
      return;
    const requestKey = currentOpenKey;
    setOpeningKey(requestKey);
    setOpenError(null);
    try {
      await openSource(sessionId, resolvedReference);
    } catch (error) {
      const message = formatPreviewError(error);
      if (mountedRef.current && currentOpenKeyRef.current === requestKey) {
        setOpenError({ key: requestKey, message });
        toast.error(message);
      }
    } finally {
      if (mountedRef.current)
        setOpeningKey((current) => (current === requestKey ? null : current));
    }
  };

  const selectedState = resolvedReference
    ? formatSourceState(resolvedReference.state)
    : null;
  const selectedLocator = resolvedReference
    ? formatLocator(resolvedReference.locator)
    : null;
  const observedAt = resolvedReference
    ? formatObservedAt(resolvedReference.observedAt)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="study-source-description"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Sources and versions</DialogTitle>
          <DialogDescription id="study-source-description">
            Inspect the exact source version attached to this conversation.
          </DialogDescription>
        </DialogHeader>
        {visibleReferences.length === 0 ? (
          <Empty className="min-h-40 border-0 p-4">
            <EmptyMedia variant="icon">
              <BookOpenTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No sources attached</EmptyTitle>
              <EmptyDescription>
                This session has no inspectable source references yet.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-col gap-4">
            <ul
              aria-label="Session sources"
              className="flex max-h-48 flex-col gap-2 overflow-y-auto"
            >
              {visibleReferences.map((reference) => {
                const isSelected =
                  selected !== null &&
                  sourceReferenceKey(reference) ===
                    sourceReferenceKey(selected);
                const displayReference =
                  isSelected && previewMatchesSelection
                    ? (resolvedReference ?? reference)
                    : reference;
                const status = formatSourceState(displayReference.state);
                const Icon = status.Icon;
                return (
                  <li key={sourceReferenceKey(reference)}>
                    <Button
                      type="button"
                      variant="outline"
                      aria-pressed={isSelected}
                      aria-label={`Select source ${reference.title}`}
                      className={cn(
                        'h-auto w-full justify-start gap-3 whitespace-normal p-3 text-left',
                        isSelected && 'border-ring',
                      )}
                      onClick={() => onSelectReference(reference)}
                    >
                      <Icon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="break-words text-base font-medium">
                          {displayReference.title}
                        </span>
                        <span className="text-base text-muted-foreground">
                          {status.label} <span aria-hidden="true">/</span>{' '}
                          {formatSourceKind(reference.sourceKind)}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
            {selected && resolvedReference && selectedState && (
              <section
                aria-label={`Source details for ${resolvedReference.title}`}
                className="flex flex-col gap-3 border-t pt-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="break-words text-lg font-semibold">
                      {resolvedReference.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 text-base text-muted-foreground">
                      <span>{selectedState.label}</span>
                      <span aria-hidden="true">/</span>
                      <span>
                        {formatSourceProvenance(resolvedReference.provenance)}
                      </span>
                      {selectedLocator && (
                        <>
                          <span aria-hidden="true">/</span>
                          <span>{selectedLocator}</span>
                        </>
                      )}
                    </div>
                    {resolvedReference.versionId && (
                      <p className="break-all text-base text-muted-foreground">
                        Version: <code>{resolvedReference.versionId}</code>
                      </p>
                    )}
                    {observedAt && (
                      <p className="text-base text-muted-foreground">
                        Observed: {observedAt}
                      </p>
                    )}
                  </div>
                  {selectedState.canOpen && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        !openSource ||
                        opening ||
                        (previewMatchesSelection &&
                          previewState.status === 'unavailable' &&
                          Boolean(previewState.blocksOpening))
                      }
                      aria-label="Open current source"
                      onClick={() => void openSelectedSource()}
                    >
                      <LoadingSwap isLoading={opening}>
                        Open current source
                      </LoadingSwap>
                    </Button>
                  )}
                </div>
                {selectedState.canOpen && !openSource && (
                  <p className="text-base text-muted-foreground">
                    Opening current sources is unavailable in this build.
                  </p>
                )}
                {visibleOpenError && (
                  <p className="text-base text-destructive" role="alert">
                    {visibleOpenError}
                  </p>
                )}
                {previewState.status === 'loading' &&
                  previewMatchesSelection && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="flex items-center gap-2 text-base text-muted-foreground"
                    >
                      <LoaderCircleIcon
                        aria-hidden="true"
                        className="size-4 motion-safe:animate-spin"
                      />
                      Loading source preview
                    </p>
                  )}
                {previewState.status === 'unavailable' &&
                  previewMatchesSelection && (
                    <p
                      role="status"
                      className="text-base text-muted-foreground"
                    >
                      {previewState.message}
                    </p>
                  )}
                {previewState.status === 'ready' && previewMatchesSelection && (
                  <SourcePreviewContent
                    result={previewState.result}
                    title={previewState.result.reference.title}
                  />
                )}
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
