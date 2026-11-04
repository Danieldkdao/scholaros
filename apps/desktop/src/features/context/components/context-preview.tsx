import { useEffect, useState } from 'react';
import type {
  ContextPreview as ContextPreviewData,
  IngestionStatus,
  Locator,
} from '@scholaros/services/learning/context-contracts';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { CircleAlert, CircleCheck, CircleHelp, Loader2 } from 'lucide-react';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import type { ContextItemDetails } from '../hooks/use-context-library';

type ContextPreviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ContextItemDetails | null;
  selectedVersionId: string | null;
  preview: ContextPreviewData | null;
  loading: boolean;
  retrying: boolean;
  onVersionChange: (versionId: string) => void;
  onRetry: () => void;
};

const formatIngestionStatus = (status: IngestionStatus) => {
  switch (status) {
    case 'queued':
      return { label: 'Waiting to read', Icon: Loader2 };
    case 'processing':
      return { label: 'Reading', Icon: Loader2 };
    case 'complete':
      return { label: 'Complete', Icon: CircleCheck };
    case 'partial':
      return { label: 'Partially available', Icon: CircleAlert };
    case 'unreadable':
      return { label: 'Unreadable', Icon: CircleAlert };
    case 'unsupported':
      return { label: 'Unsupported file', Icon: CircleAlert };
    case 'failed':
      return { label: 'Could not read', Icon: CircleAlert };
    case 'cancelled':
      return { label: 'Reading stopped', Icon: CircleAlert };
  }
};

const formatLocator = (locator: Locator) => {
  switch (locator.kind) {
    case 'page':
      return `Page ${locator.page}`;
    case 'heading':
      return `Heading: ${locator.heading}`;
    case 'paragraph':
      return `Paragraph ${locator.ordinal}`;
  }
};

const formatUnavailableReason = (
  reason: Extract<ContextPreviewData, { kind: 'unavailable' }>['reason'],
) => {
  switch (reason) {
    case 'removed':
      return 'The original source is no longer available.';
    case 'unreadable':
      return 'This source could not be read.';
    case 'unsupported':
      return 'This file type is not supported.';
    case 'offline':
      return 'Preview is unavailable while ScholarOS is offline.';
    case 'processing':
      return 'This source is still being processed.';
  }
};

export const ContextPreview = ({
  open,
  onOpenChange,
  details,
  selectedVersionId,
  preview,
  loading,
  retrying,
  onVersionChange,
  onRetry,
}: ContextPreviewProps) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const image = preview?.kind === 'image' ? preview : null;
  const selectedVersion = details?.versions.find(
    (version) => version.id === selectedVersionId,
  );
  const isHistorical =
    !!selectedVersionId && selectedVersionId !== details?.item.currentVersionId;
  const canRetry =
    !isHistorical &&
    !!details &&
    (details.item.kind === 'document' || details.item.kind === 'image') &&
    details.item.status !== 'queued' &&
    details.item.status !== 'processing';
  const formattedStatus = selectedVersion
    ? formatIngestionStatus(selectedVersion.extractionStatus)
    : null;

  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const source = URL.createObjectURL(
      new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
    );
    setImageUrl(source);
    return () => URL.revokeObjectURL(source);
  }, [image]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{details?.item.title ?? 'Context preview'}</DialogTitle>
          <DialogDescription>
            Review the saved source and the pages ScholarOS could interpret.
          </DialogDescription>
        </DialogHeader>
        {details && details.versions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span id="context-preview-version-label">Version</span>
            <Select
              value={selectedVersionId}
              onValueChange={(value) => {
                if (typeof value === 'string') onVersionChange(value);
              }}
            >
              <SelectTrigger
                aria-labelledby="context-preview-version-label"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {details.versions.map((version) => (
                  <SelectItem key={version.id} value={version.id}>
                    {version.id === details.item.currentVersionId
                      ? 'Current version'
                      : `Earlier version: ${formatObservedAt(version.createdAt)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {selectedVersion && (
          <div className="flex flex-wrap items-center gap-3 text-base text-muted-foreground">
            {formattedStatus && (
              <span className="flex items-center gap-2">
                <formattedStatus.Icon aria-hidden="true" className="size-4" />
                {formattedStatus.label}
              </span>
            )}
            {isHistorical && <span>Earlier version</span>}
            {!selectedVersion.originalAvailable && (
              <span>Original file unavailable</span>
            )}
          </div>
        )}
        {loading ? (
          <div
            role="status"
            aria-label="Loading preview"
            className="flex items-center gap-2"
          >
            <Loader2
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
            Loading preview
          </div>
        ) : preview?.kind === 'text' ? (
          <div className="flex flex-col gap-3">
            {preview.partial && (
              <Alert>
                <CircleAlert aria-hidden="true" />
                <AlertDescription>
                  Some pages could not be interpreted; the available text is
                  still shown.
                </AlertDescription>
              </Alert>
            )}
            {preview.uncertainty && (
              <Alert>
                <CircleHelp aria-hidden="true" />
                <AlertDescription>{preview.uncertainty}</AlertDescription>
              </Alert>
            )}
            {selectedVersion && selectedVersion.interpretedPages.length > 0 && (
              <p className="text-base text-muted-foreground">
                Interpreted pages: {selectedVersion.interpretedPages.join(', ')}
                {selectedVersion.pageCount === null
                  ? ''
                  : ` of ${selectedVersion.pageCount}`}
              </p>
            )}
            {preview.locators.length > 0 && (
              <p className="text-base text-muted-foreground">
                Source locations:{' '}
                {preview.locators.map(formatLocator).join(', ')}
              </p>
            )}
            <pre
              aria-label="Interpreted source text"
              className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-4 text-base"
            >
              {preview.text}
            </pre>
          </div>
        ) : preview?.kind === 'image' ? (
          imageUrl ? (
            <img
              src={imageUrl}
              alt={`Preview of ${details?.item.title ?? 'source image'}`}
              className="max-h-96 max-w-full rounded-md object-contain"
            />
          ) : (
            <div role="status" aria-label="Preparing image preview">
              Preparing image preview
            </div>
          )
        ) : preview?.kind === 'unavailable' ? (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              <span>{formatUnavailableReason(preview.reason)}</span>
              {selectedVersion && !selectedVersion.originalAvailable && (
                <span>
                  {' '}
                  The interpreted version may still be available above.
                </span>
              )}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              Could not load this preview. Try again.
            </AlertDescription>
          </Alert>
        )}
        {canRetry && (
          <Button
            type="button"
            variant="outline"
            disabled={retrying}
            onClick={onRetry}
          >
            <LoadingSwap isLoading={retrying}>Try again</LoadingSwap>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};
