import { useEffect, useRef, useState } from 'react';
import {
  gradeSettingsSchema,
  type GradeSettings as GradeSettingsValue,
} from '@scholaros/services/learning/grade-contracts';
import { GradeSettings } from '../../grades/components/grade-settings';
import { errorMessage } from '../../../lib/error-message';

export const GradeSettingsSection = ({ accountId }: { accountId: string }) => {
  const [snapshot, setSnapshot] = useState<{
    accountId: string;
    settings: GradeSettingsValue;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const activeAccount = useRef(accountId);
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  activeAccount.current = accountId;
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setFailure(null);
    const read = async () => {
      if ((await window.scholar.getCurrentUser())?.id !== accountId)
        throw new Error(
          'Your session changed; sign in again to load grade settings.',
        );
      const settings = gradeSettingsSchema.parse(
        await window.scholar.getGradeSettings({}),
      );
      if (
        active &&
        activeAccount.current === accountId &&
        (await window.scholar.getCurrentUser())?.id === accountId
      )
        setSnapshot({ accountId, settings });
    };
    void read().catch((cause) => {
      if (active)
        setFailure(errorMessage(cause, 'Could not load grade settings.'));
    });
    return () => {
      active = false;
    };
  }, [accountId]);
  const settings = snapshot?.accountId === accountId ? snapshot.settings : null;
  if (!settings)
    return (
      <p
        role={failure ? 'alert' : 'status'}
        className={failure ? 'text-destructive' : 'text-muted-foreground'}
      >
        {failure ?? 'Loading grade settings'}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      <GradeSettings
        accountId={accountId}
        settings={settings}
        onSave={(changes) => {
          const operation = saves.current
            .catch(() => undefined)
            .then(async () => {
              try {
                if (
                  activeAccount.current !== accountId ||
                  (await window.scholar.getCurrentUser())?.id !== accountId
                )
                  throw new Error('Your session changed; reopen settings.');
                const current = gradeSettingsSchema.parse(
                  await window.scholar.getGradeSettings({}),
                );
                if (
                  activeAccount.current !== accountId ||
                  (await window.scholar.getCurrentUser())?.id !== accountId
                )
                  throw new Error('Your session changed; reopen settings.');
                const saved = gradeSettingsSchema.parse(
                  await window.scholar.saveGradeSettings({
                    ...changes,
                    expectedRevision: current.revision,
                  }),
                );
                if (
                  activeAccount.current !== accountId ||
                  (await window.scholar.getCurrentUser())?.id !== accountId
                )
                  throw new Error('Your session changed; reopen settings.');
                setSnapshot({ accountId, settings: saved });
                setFailure(null);
                return saved;
              } catch (cause) {
                if (activeAccount.current === accountId)
                  setFailure(
                    errorMessage(cause, 'Could not save grade settings.'),
                  );
                throw cause;
              }
            });
          saves.current = operation;
          return operation;
        }}
      />
    </div>
  );
};
