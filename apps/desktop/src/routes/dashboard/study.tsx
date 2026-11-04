import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { studyActivities } from '@scholaros/services/learning/study-contracts';
import { idSchema } from '@scholaros/services/learning/product-contracts';
import { z } from 'zod';
import { useCurrentUser } from '../../features/dashboard/hooks/use-current-user';
import { StudyLanding } from '../../features/study/components/study-landing';

export const studySetupPrefillSearchSchema = z.strictObject({
  activity: z.enum(studyActivities).optional(),
  courseId: idSchema.optional(),
  targetAssignmentId: idSchema.optional(),
  topic: z.string().max(1000).optional(),
  contextItemIds: z.array(idSchema).max(20).optional(),
});
export type StudySetupPrefillSearchSchema = z.infer<
  typeof studySetupPrefillSearchSchema
>;

const StudyLandingRoute = () => {
  const search = Route.useSearch();
  const { user, loading, reload } = useCurrentUser();
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

  if (loading && !user) return <p role="status">Loading Study.</p>;
  if (user)
    return (
      <StudyLanding
        key={`${user.id}:${snapshotEpoch}`}
        accountId={user.id}
        initialSetup={search}
        offline={user.authMode === 'offline-local'}
      />
    );
  if (user === null) return <p role="status">Sign in to continue to Study.</p>;
  return <p role="status">Loading Study.</p>;
};

export const Route = createFileRoute('/dashboard/study')({
  validateSearch: studySetupPrefillSearchSchema,
  component: StudyLandingRoute,
});
