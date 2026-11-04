import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import type {
  ContextItemDTO,
  ContextVersionDTO,
  ContextKind,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';
import type {
  LearningMethodContracts,
  Page,
  PageInput,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { CourseSummary } from '../../courses/types';

type ContractInput<Name extends keyof LearningMethodContracts> =
  LearningMethodContracts[Name]['input'];
type ContractResult<Name extends keyof LearningMethodContracts> =
  LearningMethodContracts[Name]['result'];

type ReadMethod<
  Name extends 'listContextItems' | 'getContextItem' | 'readContextPreview',
> = (input: ContractInput<Name>) => Promise<ContractResult<Name> | null>;

type MutationMethod<
  Name extends
    | 'createContextNote'
    | 'updateContextItem'
    | 'linkContextItem'
    | 'removeContextItem'
    | 'retryContextIngestion'
    | 'upsertExplicitPreference',
> = (input: ContractInput<Name>) => Promise<ContractResult<Name>>;

export type ContextLibraryApi = {
  listContextItems: ReadMethod<'listContextItems'>;
  getContextItem: ReadMethod<'getContextItem'>;
  readContextPreview: ReadMethod<'readContextPreview'>;
  createContextNote: MutationMethod<'createContextNote'>;
  updateContextItem: MutationMethod<'updateContextItem'>;
  linkContextItem: MutationMethod<'linkContextItem'>;
  removeContextItem: MutationMethod<'removeContextItem'>;
  retryContextIngestion: MutationMethod<'retryContextIngestion'>;
  upsertExplicitPreference: MutationMethod<'upsertExplicitPreference'>;
  chooseContextFiles: (input: {
    courseId?: string;
    saveToLibrary: true;
  }) => Promise<{
    items: { itemId: string; operationId: string; status: IngestionStatus }[];
    cancelled: boolean;
  }>;
  openSource: (url: string) => Promise<void>;
};

export type ContextItemDetails = {
  item: ContextItemDTO;
  versions: ContextVersionDTO[];
};

export type ContextCourse = Pick<CourseSummary, 'id' | 'name' | 'url'>;
export type ContextEventSubscription = (
  listener: (event: ProductEventV1) => void,
) => () => void;

export type ContextLibraryKindFilter = ContextKind | 'all';
export type ContextLibraryStatusFilter = IngestionStatus | 'all';
export type ContextLibraryCourseFilter =
  | 'all'
  | 'unassigned'
  | `course:${string}`;

type ContextLibraryFailure = 'offline' | 'sign-in' | 'failed';
type ScopedSnapshot = { scopeKey: string; page: Page<ContextItemDTO> };
type ScopedLoadFailure = {
  scopeKey: string;
  message: string;
  failure: ContextLibraryFailure;
};
type ScopedLoadMoreError = { scopeKey: string; message: string };

const pageSize = 25;

const getFailure = (cause: unknown): ContextLibraryFailure => {
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : cause instanceof Error
        ? cause.message
        : null;
  if (code === 'offline') return 'offline';
  if (code === 'needs-sign-in') return 'sign-in';
  return 'failed';
};

const getLoadError = (failure: ContextLibraryFailure) => {
  switch (failure) {
    case 'offline':
      return 'You’re offline. Reconnect to view saved Context.';
    case 'sign-in':
      return 'Reconnect your learning account to view Context.';
    case 'failed':
      return 'Could not load your Context. Try again.';
  }
};

export const useContextLibrary = (
  accountId: string | null,
  api: ContextLibraryApi,
  subscribeToEvents: ContextEventSubscription,
  readOnly = false,
  refreshEpoch = 0,
) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const normalizedQuery = debouncedQuery.trim().slice(0, 200);
  const [kindFilter, setKindFilter] = useState<ContextLibraryKindFilter>('all');
  const [statusFilter, setStatusFilter] =
    useState<ContextLibraryStatusFilter>('all');
  const [courseFilter, setCourseFilter] =
    useState<ContextLibraryCourseFilter>('all');
  const [snapshotState, setSnapshotState] = useState<ScopedSnapshot | null>(
    null,
  );
  const [requestLoading, setRequestLoading] = useState(true);
  const [requestScope, setRequestScope] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailureState, setLoadFailureState] =
    useState<ScopedLoadFailure | null>(null);
  const [loadMoreErrorState, setLoadMoreErrorState] =
    useState<ScopedLoadMoreError | null>(null);
  const requests = useRef(0);
  const accountRef = useRef(accountId);
  const requiredRevision = useRef(0);
  const scopeKey = `${accountId ?? ''}\u0000${normalizedQuery}\u0000${courseFilter}\u0000${readOnly}`;
  const snapshot =
    snapshotState?.scopeKey === scopeKey ? snapshotState.page : null;
  const loading =
    accountId !== null && (requestLoading || requestScope !== scopeKey);
  const loadError =
    loadFailureState?.scopeKey === scopeKey ? loadFailureState.message : null;
  const loadFailure =
    loadFailureState?.scopeKey === scopeKey ? loadFailureState.failure : null;
  const loadMoreError =
    loadMoreErrorState?.scopeKey === scopeKey
      ? loadMoreErrorState.message
      : null;
  const pageRef = useRef(snapshot);
  const scopeKeyRef = useRef(scopeKey);
  if (accountRef.current !== accountId) {
    accountRef.current = accountId;
    requiredRevision.current = 0;
    requests.current += 1;
  }
  pageRef.current = snapshot;
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    requests.current += 1;
  }

  const isCurrentRequest = useCallback(
    (request: number, requestedAccount: string, requestedScope: string) =>
      requests.current === request &&
      accountRef.current === requestedAccount &&
      scopeKeyRef.current === requestedScope,
    [],
  );

  const pageInput = useCallback(
    (cursor?: string): PageInput => ({
      ...(normalizedQuery ? { query: normalizedQuery } : {}),
      ...(courseFilter === 'all'
        ? {}
        : {
            courseId:
              courseFilter === 'unassigned'
                ? null
                : courseFilter.slice('course:'.length),
          }),
      ...(cursor ? { cursor } : {}),
      limit: pageSize,
    }),
    [courseFilter, normalizedQuery],
  );

  const loadFirstPage = useCallback(async () => {
    if (scopeKeyRef.current !== scopeKey) return;
    if (!accountId) {
      setSnapshotState(null);
      setLoadFailureState(null);
      setLoadMoreErrorState(null);
      setRequestScope(scopeKey);
      setRequestLoading(false);
      setLoadingMore(false);
      return;
    }
    const request = ++requests.current;
    const requestedAccount = accountId;
    const requestedScope = scopeKey;
    setSnapshotState(null);
    setLoadFailureState(null);
    setLoadMoreErrorState(null);
    setRequestScope(requestedScope);
    setRequestLoading(true);
    setLoadingMore(false);
    try {
      const page = await api.listContextItems(pageInput());
      if (!isCurrentRequest(request, requestedAccount, requestedScope)) return;
      if (!page) {
        const failure: ContextLibraryFailure = 'failed';
        setLoadFailureState({
          scopeKey: requestedScope,
          failure,
          message: getLoadError(failure),
        });
        return;
      }
      if (page.revision < requiredRevision.current) {
        setLoadFailureState({
          scopeKey: requestedScope,
          failure: 'failed',
          message: 'Context changed while loading. Try again to refresh.',
        });
        return;
      }
      setSnapshotState({ scopeKey: requestedScope, page });
    } catch (cause) {
      if (!isCurrentRequest(request, requestedAccount, requestedScope)) return;
      const failure = getFailure(cause);
      setLoadFailureState({
        scopeKey: requestedScope,
        failure,
        message: getLoadError(failure),
      });
    } finally {
      if (isCurrentRequest(request, requestedAccount, requestedScope))
        setRequestLoading(false);
    }
  }, [accountId, api, isCurrentRequest, pageInput, scopeKey]);

  const loadMore = useCallback(async () => {
    if (scopeKeyRef.current !== scopeKey) return;
    const currentPage = pageRef.current;
    if (!accountId || !currentPage?.nextCursor || loadingMore || loading)
      return;
    const request = requests.current;
    const requestedAccount = accountId;
    const requestedScope = scopeKey;
    const requestedRevision = currentPage.revision;
    setLoadingMore(true);
    setLoadMoreErrorState(null);
    try {
      const nextPage = await api.listContextItems(
        pageInput(currentPage.nextCursor),
      );
      if (!isCurrentRequest(request, requestedAccount, requestedScope)) return;
      if (!nextPage) throw new Error('Could not load more Context items.');
      if (
        nextPage.revision !== requestedRevision ||
        nextPage.revision < requiredRevision.current
      ) {
        await loadFirstPage();
        return;
      }
      setSnapshotState((previousState) => {
        const previousPage =
          previousState?.scopeKey === requestedScope
            ? previousState.page
            : null;
        if (!previousPage || previousPage.revision !== nextPage.revision)
          return previousState;
        const existingIds = new Set(previousPage.items.map((item) => item.id));
        return {
          scopeKey: requestedScope,
          page: {
            ...nextPage,
            items: [
              ...previousPage.items,
              ...nextPage.items.filter((item) => !existingIds.has(item.id)),
            ],
          },
        };
      });
    } catch {
      if (isCurrentRequest(request, requestedAccount, requestedScope))
        setLoadMoreErrorState({
          scopeKey: requestedScope,
          message: 'Could not load more Context items. Try again.',
        });
    } finally {
      if (isCurrentRequest(request, requestedAccount, requestedScope))
        setLoadingMore(false);
    }
  }, [
    accountId,
    api,
    isCurrentRequest,
    loadFirstPage,
    loading,
    loadingMore,
    pageInput,
    scopeKey,
  ]);

  useEffect(() => {
    if (!accountId) {
      requiredRevision.current = 0;
      setSnapshotState(null);
      setRequestScope(scopeKey);
      setRequestLoading(false);
      setLoadingMore(false);
      return;
    }
    return subscribeToEvents((event) => {
      if (
        accountRef.current !== accountId ||
        event.accountId !== accountId ||
        event.resource !== 'context'
      )
        return;
      requiredRevision.current = Math.max(
        requiredRevision.current,
        event.revision,
      );
      void loadFirstPage();
    });
  }, [accountId, loadFirstPage, subscribeToEvents]);

  useEffect(() => {
    void loadFirstPage();
  }, [accountId, loadFirstPage, refreshEpoch]);

  const items = snapshot?.items ?? [];
  const visibleItems = items.filter(
    (item) =>
      (kindFilter === 'all' || item.kind === kindFilter) &&
      (statusFilter === 'all' || item.status === statusFilter),
  );

  return {
    accountId,
    items,
    visibleItems,
    loading,
    loadingMore,
    loadError,
    loadFailure,
    loadMoreError,
    hasMore: !!snapshot?.nextCursor,
    revision: snapshot?.revision ?? 0,
    query,
    setQuery,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
    courseFilter,
    setCourseFilter,
    reload: loadFirstPage,
    loadMore: () => void loadMore(),
  };
};
