import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import { ActivityHost } from '../../features/study/components/activity-host';
import {
  StudyDocument,
  StudyDocumentRenderersProvider,
} from '../../features/study/components/study-document';
import type { StudyDocumentRenderers } from '../../features/study/components/study-document';
import { DictationControl } from '../../features/speech/components/dictation-control';
import { PracticeView } from '../../features/practice/components/practice-view';
import { ProgressSummary } from '../../features/memory/components/progress-summary';
import { useCurrentUser } from '../../features/dashboard/hooks/use-current-user';

const StudySessionRoute = () => {
  const { sessionId } = Route.useParams();
  const navigate = Route.useNavigate();
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

  const readSourcePreview = useCallback(
    async (currentSessionId: string, reference: SourceReference) => {
      if (
        reference.sourceKind !== 'context-version' &&
        reference.sourceKind !== 'saved-activity'
      )
        return null;
      const preview = await window.scholar.readContextPreview({
        itemId: reference.sourceId,
        ...(reference.versionId ? { versionId: reference.versionId } : {}),
        sessionId: currentSessionId,
      });
      return preview ? { reference, preview } : null;
    },
    [],
  );
  const openSource = useCallback(
    async (_currentSessionId: string, reference: SourceReference) => {
      switch (reference.sourceKind) {
        case 'assignment':
        case 'announcement': {
          if (!reference.courseId)
            throw new Error('This course source is no longer available.');
          const course = await window.scholar.getCourse(reference.courseId);
          const item =
            reference.sourceKind === 'assignment'
              ? course?.assignments.find(
                  (candidate) =>
                    candidate.id === reference.sourceId && candidate.active,
                )
              : course?.announcements.find(
                  (candidate) =>
                    candidate.id === reference.sourceId && candidate.active,
                );
          if (!item)
            throw new Error('This course source is no longer available.');
          await window.scholar.openSource(item.url);
          return;
        }
        case 'course-material':
        case 'grade-evidence':
          if (!reference.courseId)
            throw new Error('This course source is no longer available.');
          await navigate({
            to: '/dashboard/courses/$courseId',
            params: { courseId: reference.courseId },
          });
          return;
        case 'context-version':
        case 'saved-activity':
          await navigate({
            to: '/dashboard/context',
            search: { itemId: reference.sourceId },
          });
          return;
      }
    },
    [navigate],
  );
  const renderers = useMemo<StudyDocumentRenderers>(
    () => ({
      ActivityHost,
      PracticeView,
      DictationControl,
      ProgressSummary,
      readSourcePreview,
      openSource,
    }),
    [openSource, readSourcePreview],
  );

  if (loading && !user) return <p role="status">Loading study session.</p>;
  if (!user) return <p role="alert">Sign in to open this study session.</p>;
  return (
    <StudyDocumentRenderersProvider renderers={renderers}>
      <StudyDocument
        key={`${user.id}:${sessionId}`}
        accountId={user.id}
        sessionId={sessionId}
        readOnly={user.authMode === 'offline-local'}
        refreshEpoch={snapshotEpoch}
      />
    </StudyDocumentRenderersProvider>
  );
};

export const Route = createFileRoute('/study/$sessionId')({
  component: StudySessionRoute,
});
