import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { StudyHistory } from './study-history';
import { StudySetup } from './study-setup';
import type { StudySetupPrefill } from './study-setup';

export type { StudySetupPrefill } from './study-setup';

type StudyLandingProps = {
  accountId: string;
  initialSetup?: StudySetupPrefill;
  offline?: boolean;
};

export const StudyLanding = ({
  accountId,
  initialSetup,
  offline = false,
}: StudyLandingProps) => {
  const navigate = useNavigate();
  const openSession = useCallback(
    async (sessionId: string) => {
      // P15 owns the typed focus route and shared route-tree regeneration.
      await navigate({
        to: '/study/$sessionId',
        params: { sessionId },
      } as never);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col gap-6 text-base">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Study</h1>
        <p className="text-base text-muted-foreground">
          Start with one course and return to a saved session whenever you are
          ready.
        </p>
      </header>
      <StudySetup
        key={`study-setup:${accountId}`}
        accountId={accountId}
        initialSetup={initialSetup}
        offline={offline}
        onStarted={(session) => openSession(session.id)}
      />
      <StudyHistory
        key={`study-history:${accountId}`}
        accountId={accountId}
        offline={offline}
        onResume={openSession}
      />
    </div>
  );
};
