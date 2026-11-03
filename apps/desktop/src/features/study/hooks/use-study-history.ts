import { useDebouncedValue } from '@tanstack/react-pacer';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContextItemDTO,
  ContextPreview,
  ContextVersionDTO,
} from '@scholaros/services/learning/context-contracts';
import type {
  Page,
  PageInput,
} from '@scholaros/services/learning/product-contracts';
import type {
  CreateStudySessionInput,
  StudySessionDTO,
  StudySessionStatus,
} from '@scholaros/services/learning/study-contracts';
import { errorMessage } from '../../../lib/error-message';

const pageSize = 25;

type StudyApi = {
  createStudySession: (
    input: CreateStudySessionInput,
  ) => Promise<StudySessionDTO>;
  listContextItems: (input: PageInput) => Promise<Page<ContextItemDTO> | null>;
  getContextItem: (input: { itemId: string; versionId?: string }) => Promise<{
    item: ContextItemDTO;
    versions: ContextVersionDTO[];
    preview: ContextPreview;
  } | null>;
  listStudySessions: (
    input: PageInput & { status?: StudySessionStatus },
  ) => Promise<Page<StudySessionDTO> | null>;
  renameStudySession: (input: {
    sessionId: string;
    title: string;
    expectedRevision: number;
  }) => Promise<StudySessionDTO>;
  deleteStudySession: (input: {
    sessionId: string;
    expectedRevision: number;
    requestId: string;
  }) => Promise<void>;
};

export const getStudyApi = () =>
  window.scholar as typeof window.scholar & StudyApi;

type StudyHistoryOptions = {
  accountId: string | null;
};

export const useStudyHistory = ({ accountId }: StudyHistoryOptions) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const [courseId, setCourseId] = useState<string | null>(null);
  const [status, setStatus] = useState<StudySessionStatus | null>(null);
  const [sessions, setSessions] = useState<StudySessionDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const request = useRef(0);
  const deletedIds = useRef(new Set<string>());
  const renamedSessions = useRef(new Map<string, StudySessionDTO>());
  const deleteRequestIds = useRef(
    new Map<string, { revision: number; requestId: string }>(),
  );
  const latestPageRevision = useRef(-1);

  const load = useCallback(async () => {
    if (!accountId) {
      setSessions([]);
      setNextCursor(null);
      setLoadError(null);
      setLoadMoreError(null);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const attempt = ++request.current;
    setLoading(true);
    setLoadingMore(false);
    setLoadError(null);
    setLoadMoreError(null);
    const input: PageInput & { status?: StudySessionStatus } = {
      query: debouncedQuery.trim() || undefined,
      ...(courseId ? { courseId } : {}),
      ...(status ? { status } : {}),
      limit: pageSize,
    };
    try {
      const result = await getStudyApi().listStudySessions(input);
      if (!result) throw new Error('Could not load your study history.');
      if (
        attempt !== request.current ||
        result.revision < latestPageRevision.current
      )
        return;
      latestPageRevision.current = result.revision;
      const visible = result.items
        .filter((session) => !deletedIds.current.has(session.id))
        .map((session) => {
          const renamed = renamedSessions.current.get(session.id);
          return renamed && renamed.revision > session.revision
            ? renamed
            : session;
        });
      setSessions(visible);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (attempt === request.current)
        setLoadError(errorMessage(cause, 'Could not load your study history.'));
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }, [accountId, courseId, debouncedQuery, status]);

  useEffect(() => {
    deletedIds.current.clear();
    renamedSessions.current.clear();
    deleteRequestIds.current.clear();
    latestPageRevision.current = -1;
    setQuery('');
    setCourseId(null);
    setStatus(null);
    setSessions([]);
    setNextCursor(null);
  }, [accountId]);

  useEffect(() => {
    setSessions([]);
    setNextCursor(null);
    if (!accountId) {
      setLoading(false);
      setLoadError(null);
      return;
    }
    void load();
    return () => {
      request.current += 1;
    };
  }, [accountId, load]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!accountId || !nextCursor || loadingMore) return;
    const attempt = ++request.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    const input: PageInput & { status?: StudySessionStatus } = {
      query: debouncedQuery.trim() || undefined,
      ...(courseId ? { courseId } : {}),
      ...(status ? { status } : {}),
      cursor: nextCursor,
      limit: pageSize,
    };
    try {
      const result = await getStudyApi().listStudySessions(input);
      if (!result) throw new Error('Could not load more study sessions.');
      if (
        attempt !== request.current ||
        result.revision < latestPageRevision.current
      )
        return;
      latestPageRevision.current = result.revision;
      setSessions((current) => {
        const items = new Map(current.map((session) => [session.id, session]));
        for (const session of result.items) {
          if (deletedIds.current.has(session.id)) continue;
          const renamed = renamedSessions.current.get(session.id);
          const next =
            renamed && renamed.revision > session.revision ? renamed : session;
          const existing = items.get(session.id);
          if (!existing || next.revision >= existing.revision)
            items.set(session.id, next);
        }
        return [...items.values()];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (attempt === request.current)
        setLoadMoreError(
          errorMessage(cause, 'Could not load more study sessions.'),
        );
    } finally {
      if (attempt === request.current) setLoadingMore(false);
    }
  }, [accountId, courseId, debouncedQuery, loadingMore, nextCursor, status]);

  const renameSession = useCallback(
    async (session: StudySessionDTO, title: string) => {
      const renamed = await getStudyApi().renameStudySession({
        sessionId: session.id,
        title: title.trim(),
        expectedRevision: session.revision,
      });
      renamedSessions.current.set(session.id, renamed);
      setSessions((current) =>
        current.map((item) => (item.id === renamed.id ? renamed : item)),
      );
      await load();
      return renamed;
    },
    [load],
  );

  const deleteSession = useCallback(async (session: StudySessionDTO) => {
    const previousRequest = deleteRequestIds.current.get(session.id);
    const requestId =
      previousRequest?.revision === session.revision
        ? previousRequest.requestId
        : crypto.randomUUID();
    deleteRequestIds.current.set(session.id, {
      revision: session.revision,
      requestId,
    });
    await getStudyApi().deleteStudySession({
      sessionId: session.id,
      expectedRevision: session.revision,
      requestId,
    });
    request.current += 1;
    setLoading(false);
    setLoadingMore(false);
    deletedIds.current.add(session.id);
    renamedSessions.current.delete(session.id);
    deleteRequestIds.current.delete(session.id);
    setSessions((current) => current.filter((item) => item.id !== session.id));
  }, []);

  return {
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
    hasMore: nextCursor !== null,
    reload: load,
    loadMore,
    renameSession,
    deleteSession,
  };
};
