import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LearningProgress,
  MemoryDTO,
} from '@scholaros/services/learning/memory-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import type {
  InputOf,
  ResultOf,
} from '@scholaros/services/learning/product-contracts';
import { errorMessage } from '../../../lib/error-message';

const memoryPageLimit = 50;
const maximumMemoryQueryLength = 200;

export type MemoryStatus =
  | 'idle'
  | 'loading'
  | 'loading-more'
  | 'ready'
  | 'error'
  | 'offline';
export type ProgressStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';
export type MemoryFilters = {
  query?: string;
  type?: MemoryDTO['type'];
  courseId?: string;
};
export type MemoryPageState = {
  items: MemoryDTO[];
  revision: number | null;
  nextCursor: string | null;
  status: MemoryStatus;
  error: string | null;
};
export type LearningProgressState = {
  progress: LearningProgress | null;
  status: ProgressStatus;
  error: string | null;
};

type MemoryBridge = {
  listMemories: (
    input: InputOf<'listMemories'>,
  ) => Promise<ResultOf<'listMemories'> | null>;
  correctMemory: (
    input: InputOf<'correctMemory'>,
  ) => Promise<ResultOf<'correctMemory'>>;
  deleteMemory: (input: InputOf<'deleteMemory'>) => Promise<void>;
  getLearningProgress: (
    input: InputOf<'getLearningProgress'>,
  ) => Promise<ResultOf<'getLearningProgress'> | null>;
  onProductEvent: (listener: (event: ProductEventV1) => void) => () => void;
};

const memoryBridge = () => window.scholar as unknown as MemoryBridge;

const memoryScope = (
  accountId: string | null,
  query: string,
  type: MemoryDTO['type'] | undefined,
  courseId: string | undefined,
) => JSON.stringify([accountId, query, type, courseId]);

const emptyMemoryPage = (
  scope: string,
  status: MemoryStatus = 'loading',
): MemoryPageState & { scope: string } => ({
  scope,
  items: [],
  revision: null,
  nextCursor: null,
  status,
  error: null,
});

const failedStatus = (): 'error' | 'offline' =>
  typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error';

const failedMessage = (cause: unknown, fallback: string) =>
  failedStatus() === 'offline'
    ? 'Reconnecting to remembered information; try again when the device is online.'
    : errorMessage(cause, fallback);

export const useMemory = (
  accountId: string | null,
  filters: MemoryFilters = {},
) => {
  const query = (filters.query ?? '').trim().slice(0, maximumMemoryQueryLength);
  const type = filters.type;
  const courseId = filters.courseId;
  const scope = memoryScope(accountId, query, type, courseId);
  const request = useRef(0);
  const activeScope = useRef(scope);
  const [state, setState] = useState(() => emptyMemoryPage(scope));
  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(async () => {
    if (!accountId) {
      request.current += 1;
      setState(emptyMemoryPage(scope, 'idle'));
      return;
    }
    const attempt = ++request.current;
    setState(emptyMemoryPage(scope));
    try {
      const page = await memoryBridge().listMemories({
        limit: memoryPageLimit,
        ...(query ? { query } : {}),
        ...(type ? { type } : {}),
        ...(courseId ? { courseId } : {}),
      });
      if (attempt !== request.current) return;
      if (!page) throw new Error('Could not load remembered information.');
      setState({
        scope,
        items: page.items,
        revision: page.revision,
        nextCursor: page.nextCursor,
        status: 'ready',
        error: null,
      });
    } catch (cause) {
      if (attempt !== request.current) return;
      const status = failedStatus();
      setState({
        ...emptyMemoryPage(scope, status),
        error: failedMessage(cause, 'Could not load remembered information.'),
      });
    }
  }, [accountId, courseId, query, scope, type]);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (
      !accountId ||
      current.scope !== scope ||
      !current.nextCursor ||
      current.revision === null ||
      current.status === 'loading-more'
    )
      return;
    const attempt = ++request.current;
    const revision = current.revision;
    setState({ ...current, status: 'loading-more', error: null });
    try {
      const page = await memoryBridge().listMemories({
        limit: memoryPageLimit,
        cursor: current.nextCursor,
        ...(query ? { query } : {}),
        ...(type ? { type } : {}),
        ...(courseId ? { courseId } : {}),
      });
      if (attempt !== request.current) return;
      if (!page) throw new Error('Could not load more remembered information.');
      if (page.revision !== revision) {
        await reload();
        return;
      }
      setState({
        ...current,
        items: [
          ...current.items,
          ...page.items.filter(
            (memory) =>
              !current.items.some((existing) => existing.id === memory.id),
          ),
        ],
        revision: page.revision,
        nextCursor: page.nextCursor,
        status: 'ready',
        error: null,
      });
    } catch (cause) {
      if (attempt !== request.current) return;
      const status = failedStatus();
      setState({
        ...current,
        status,
        error: failedMessage(
          cause,
          'Could not load more remembered information.',
        ),
      });
    }
  }, [accountId, courseId, query, reload, scope, type]);

  const correct = useCallback(
    async (input: InputOf<'correctMemory'>) => {
      const correctedMemory = await memoryBridge().correctMemory(input);
      if (activeScope.current === scope && stateRef.current.scope === scope) {
        setState((current) => ({
          ...current,
          items: current.items.map((memory) =>
            memory.id === correctedMemory.id ? correctedMemory : memory,
          ),
        }));
        void reload();
      }
      return correctedMemory;
    },
    [reload, scope],
  );

  const remove = useCallback(
    async (input: InputOf<'deleteMemory'>) => {
      await memoryBridge().deleteMemory(input);
      if (activeScope.current === scope && stateRef.current.scope === scope) {
        setState((current) => ({
          ...current,
          items: current.items.filter((memory) => memory.id !== input.memoryId),
        }));
        void reload();
      }
    },
    [reload, scope],
  );

  useEffect(() => {
    activeScope.current = scope;
    void reload();
    return () => {
      request.current += 1;
      if (activeScope.current === scope) activeScope.current = '';
    };
  }, [reload, scope]);

  useEffect(() => {
    if (!accountId) return;
    const unsubscribe = memoryBridge().onProductEvent((event) => {
      if (event.accountId !== accountId || event.resource !== 'memory') return;
      const current = stateRef.current;
      if (
        current.scope === scope &&
        current.revision !== null &&
        event.revision <= current.revision
      )
        return;
      void reload();
    });
    const handleOnline = () => void reload();
    window.addEventListener('online', handleOnline);
    return () => {
      unsubscribe?.();
      window.removeEventListener('online', handleOnline);
    };
  }, [accountId, reload, scope]);

  const visibleState =
    state.scope === scope
      ? state
      : emptyMemoryPage(scope, accountId ? 'loading' : 'idle');

  return {
    ...visibleState,
    reload,
    loadMore,
    correct,
    remove,
  };
};

const emptyProgressState = (
  status: ProgressStatus = 'loading',
): LearningProgressState => ({ progress: null, status, error: null });

export const useLearningProgress = (
  accountId: string | null,
  courseId?: string,
) => {
  const scope = JSON.stringify([accountId, courseId]);
  const request = useRef(0);
  const [state, setState] = useState<LearningProgressState & { scope: string }>(
    () => ({ ...emptyProgressState(), scope }),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(async () => {
    if (!accountId) {
      request.current += 1;
      setState({ ...emptyProgressState('idle'), scope });
      return;
    }
    const attempt = ++request.current;
    setState({ ...emptyProgressState(), scope });
    try {
      const progress = await memoryBridge().getLearningProgress(
        courseId ? { courseId } : {},
      );
      if (attempt !== request.current) return;
      if (!progress) throw new Error('Could not load study progress.');
      setState({ progress, status: 'ready', error: null, scope });
    } catch (cause) {
      if (attempt !== request.current) return;
      const status = failedStatus();
      setState({
        ...emptyProgressState(status),
        error: failedMessage(cause, 'Could not load study progress.'),
        scope,
      });
    }
  }, [accountId, courseId, scope]);

  useEffect(() => {
    void reload();
    return () => {
      request.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    if (!accountId) return;
    const unsubscribe = memoryBridge().onProductEvent((event) => {
      if (event.accountId !== accountId || event.approvedTutorOutput) return;
      switch (event.resource) {
        case 'memory':
        case 'study':
        case 'context': {
          const current = stateRef.current;
          if (
            current.scope === scope &&
            current.progress &&
            event.revision <= current.progress.revision
          )
            return;
          void reload();
          return;
        }
        case 'grades':
        case 'today':
        case 'notifications':
        case 'device':
          return;
      }
    });
    const handleOnline = () => void reload();
    window.addEventListener('online', handleOnline);
    return () => {
      unsubscribe?.();
      window.removeEventListener('online', handleOnline);
    };
  }, [accountId, reload, scope]);

  if (state.scope !== scope)
    return { ...emptyProgressState(accountId ? 'loading' : 'idle'), reload };
  return { ...state, reload };
};
