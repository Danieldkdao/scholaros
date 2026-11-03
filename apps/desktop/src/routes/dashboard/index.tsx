import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { ProgressSummary } from '../../features/memory/components/progress-summary';
import { TodayPage } from '../../features/today/components/today-page';
import { useCurrentUser } from '../../features/dashboard/hooks/use-current-user';

const TodayRoute = () => {
  const { user, reload } = useCurrentUser();
  const [snapshotEpoch, setSnapshotEpoch] = useState(0);
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

  return (
    <TodayPage
      key={`${user?.id ?? 'signed-out'}:${snapshotEpoch}`}
      accountId={user?.id ?? null}
      ProgressSummaryComponent={ProgressSummary}
    />
  );
};

export const Route = createFileRoute('/dashboard/')({
  component: TodayRoute,
});
