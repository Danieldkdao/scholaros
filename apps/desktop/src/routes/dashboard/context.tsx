import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextPreview as ContextPreviewData } from '@scholaros/services/learning/context-contracts';
import { idSchema } from '@scholaros/services/learning/product-contracts';
import { z } from 'zod';
import { ContextLibrary } from '../../features/context/components/context-library';
import { ContextPreview } from '../../features/context/components/context-preview';
import type {
  ContextCourse,
  ContextEventSubscription,
  ContextItemDetails,
  ContextLibraryApi,
} from '../../features/context/hooks/use-context-library';
import { useCurrentUser } from '../../features/dashboard/hooks/use-current-user';
import { useCourses } from '../../features/courses/hooks/use-courses';
import { toast } from '@scholaros/ui/components/toast';
import { errorMessage } from '../../lib/error-message';

export const contextSearchSchema = z.strictObject({
  itemId: idSchema.optional(),
});
export type ContextSearchSchema = z.infer<typeof contextSearchSchema>;

const ContextRoute = () => {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user, loading: userLoading, reload } = useCurrentUser();
  const [snapshotEpoch, setSnapshotEpoch] = useState(0);
  const [previewDetails, setPreviewDetails] =
    useState<ContextItemDetails | null>(null);
  const [preview, setPreview] = useState<ContextPreviewData | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRetrying, setPreviewRetrying] = useState(false);
  const previewRequest = useRef(0);
  const accountId = user?.id ?? null;
  const { snapshot: courseSnapshot } = useCourses(accountId);
  const courses = useMemo<ContextCourse[]>(
    () =>
      (courseSnapshot?.courses ?? []).map(({ id, name, url }) => ({
        id,
        name,
        url,
      })),
    [courseSnapshot],
  );
  const api = useMemo<ContextLibraryApi>(
    () => ({
      listContextItems: (input) => window.scholar.listContextItems(input),
      getContextItem: (input) => window.scholar.getContextItem(input),
      readContextPreview: (input) => window.scholar.readContextPreview(input),
      createContextNote: (input) => window.scholar.createContextNote(input),
      updateContextItem: (input) => window.scholar.updateContextItem(input),
      linkContextItem: (input) => window.scholar.linkContextItem(input),
      removeContextItem: (input) => window.scholar.removeContextItem(input),
      retryContextIngestion: (input) =>
        window.scholar.retryContextIngestion(input),
      upsertExplicitPreference: (input) =>
        window.scholar.upsertExplicitPreference(input),
      chooseContextFiles: (input) => window.scholar.chooseContextFiles(input),
      openSource: (url) => window.scholar.openSource(url),
    }),
    [],
  );
  const subscribeToEvents = useCallback<ContextEventSubscription>(
    (listener) => window.scholar.onProductEvent(listener),
    [],
  );
  const refreshIdentity = useCallback(async () => {
    await reload();
    setSnapshotEpoch((current) => current + 1);
  }, [reload]);

  useEffect(() => {
    const unsubscribeAuthenticated = window.onAuthenticated(() => {
      void refreshIdentity();
    });
    const unsubscribeUserUpdated = window.onUserUpdated(() => {
      void refreshIdentity();
    });
    const unsubscribeReconnect = window.scholar.onAcademicReconnect(() => {
      void refreshIdentity();
    });
    return () => {
      unsubscribeAuthenticated();
      unsubscribeUserUpdated();
      unsubscribeReconnect();
    };
  }, [refreshIdentity]);

  useEffect(() => {
    const itemId = search.itemId;
    const requestId = ++previewRequest.current;
    if (!accountId || !itemId) {
      setPreviewDetails(null);
      setPreview(null);
      setSelectedVersionId(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewDetails(null);
    setPreview(null);
    setSelectedVersionId(null);
    setPreviewLoading(true);
    void api
      .getContextItem({ itemId })
      .then((details) => {
        if (requestId !== previewRequest.current) return;
        if (!details)
          throw new Error('This Context item is no longer available.');
        setPreviewDetails({ item: details.item, versions: details.versions });
        setPreview(details.preview);
        setSelectedVersionId(details.item.currentVersionId);
      })
      .catch((cause: unknown) => {
        if (requestId !== previewRequest.current) return;
        toast.error(errorMessage(cause, 'Could not open this Context item.'));
        void navigate({ to: '/dashboard/context', search: {} });
      })
      .finally(() => {
        if (requestId === previewRequest.current) setPreviewLoading(false);
      });
    return () => {
      previewRequest.current += 1;
    };
  }, [accountId, api, navigate, search.itemId, snapshotEpoch]);

  const dismissPreview = (open: boolean) => {
    if (!open) void navigate({ to: '/dashboard/context', search: {} });
  };
  const changeVersion = (versionId: string) => {
    const itemId = search.itemId;
    if (!itemId) return;
    const requestId = ++previewRequest.current;
    setSelectedVersionId(versionId);
    setPreviewLoading(true);
    void api
      .readContextPreview({ itemId, versionId })
      .then((result) => {
        if (requestId !== previewRequest.current) return;
        setPreview(result);
      })
      .catch((cause: unknown) => {
        if (requestId === previewRequest.current)
          toast.error(
            errorMessage(cause, 'Could not load this Context version.'),
          );
      })
      .finally(() => {
        if (requestId === previewRequest.current) setPreviewLoading(false);
      });
  };
  const retryPreview = () => {
    const itemId = search.itemId;
    if (!itemId) return;
    setPreviewRetrying(true);
    void api
      .retryContextIngestion({ itemId, requestId: crypto.randomUUID() })
      .then(() => toast.success('Context reading restarted'))
      .catch((cause: unknown) =>
        toast.error(errorMessage(cause, 'Could not retry this Context item.')),
      )
      .finally(() => setPreviewRetrying(false));
  };

  if (userLoading && !user) return <p role="status">Loading Context.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ContextLibrary
        key={`${accountId ?? 'signed-out'}:${snapshotEpoch}`}
        accountId={accountId}
        api={api}
        courses={courses}
        subscribeToEvents={subscribeToEvents}
      />
      <ContextPreview
        open={!!search.itemId}
        onOpenChange={dismissPreview}
        details={previewDetails}
        selectedVersionId={selectedVersionId}
        preview={preview}
        loading={previewLoading}
        retrying={previewRetrying}
        onVersionChange={changeVersion}
        onRetry={retryPreview}
      />
    </div>
  );
};

export const Route = createFileRoute('/dashboard/context')({
  validateSearch: contextSearchSchema,
  component: ContextRoute,
});
