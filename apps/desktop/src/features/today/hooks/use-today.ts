import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import {
  todayOverviewSchema,
  type TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import { errorMessage } from '../../../lib/error-message';

const relevantResources = new Set<ProductEventV1['resource']>([
  'context',
  'study',
  'grades',
  'memory',
  'today',
  'device',
]);

type TodayBridge = {
  getTodayOverview: (input: { limit: number }) => Promise<TodayOverview | null>;
  onProductEvent?: (listener: (event: ProductEventV1) => void) => () => void;
};

type TodayLoadState = {
  accountId: string | null;
  snapshot: TodayOverview | null;
  loading: boolean;
  error: string | null;
  offline: boolean;
};

const todayBridge = () => window.scholar as unknown as TodayBridge;

const emptyLoadState = (accountId: string | null): TodayLoadState => ({
  accountId,
  snapshot: null,
  loading: Boolean(accountId),
  error: null,
  offline: false,
});

const isOfflineError = (message: string) =>
  /offline|could not reach|connection lost/i.test(message);

export const useToday = (accountId: string | null) => {
  const [loadState, setLoadState] = useState(() => emptyLoadState(accountId));
  const scopedState =
    loadState.accountId === accountId ? loadState : emptyLoadState(accountId);
  const request = useRef(0);
  const activeAccountId = useRef(accountId);
  const eventRevisions = useRef(new Map<ProductEventV1['resource'], number>());

  const reload = useCallback(async () => {
    if (activeAccountId.current !== accountId) return;
    const attempt = ++request.current;
    if (!accountId) {
      setLoadState(emptyLoadState(null));
      return;
    }
    setLoadState((current) => ({
      ...(current.accountId === accountId
        ? current
        : emptyLoadState(accountId)),
      loading: true,
      error: null,
    }));
    try {
      const response = await todayBridge().getTodayOverview({ limit: 10 });
      const parsed = response ? todayOverviewSchema.safeParse(response) : null;
      if (!parsed?.success)
        throw new Error('Today is temporarily unavailable.');
      if (attempt !== request.current) return;
      setLoadState({
        accountId,
        snapshot: parsed.data,
        loading: false,
        error: null,
        offline: false,
      });
    } catch (cause) {
      if (attempt !== request.current) return;
      const message = errorMessage(cause, 'Today is temporarily unavailable.');
      setLoadState((current) => ({
        ...(current.accountId === accountId
          ? current
          : emptyLoadState(accountId)),
        loading: false,
        error: message,
        offline: isOfflineError(message),
      }));
    }
  }, [accountId]);

  useEffect(() => {
    activeAccountId.current = accountId;
    eventRevisions.current.clear();
    setLoadState(emptyLoadState(accountId));
    if (!accountId) return;
    void reload();
    const bridge = todayBridge();
    const unsubscribeProduct = bridge.onProductEvent?.((event) => {
      if (
        event.accountId !== accountId ||
        event.approvedTutorOutput ||
        !relevantResources.has(event.resource)
      )
        return;
      const previousRevision = eventRevisions.current.get(event.resource) ?? -1;
      if (event.revision <= previousRevision) return;
      eventRevisions.current.set(event.resource, event.revision);
      void reload();
    });
    const unsubscribeCourses = window.scholar.onCoursesChange(
      ({ accountId: changed }) => {
        if (changed === accountId) void reload();
      },
    );
    const unsubscribeSync = window.scholar.onBackgroundSyncChange(
      ({ accountId: changed }) => {
        if (changed === accountId) void reload();
      },
    );
    const unsubscribeWatch = window.scholar.onWatchChange?.(
      ({ accountId: changed }) => {
        if (changed === accountId) void reload();
      },
    );
    return () => {
      if (activeAccountId.current === accountId) activeAccountId.current = null;
      request.current += 1;
      unsubscribeProduct?.();
      unsubscribeCourses();
      unsubscribeSync();
      unsubscribeWatch?.();
    };
  }, [accountId, reload]);

  return { ...scopedState, reload };
};
