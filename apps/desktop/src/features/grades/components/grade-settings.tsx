import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import { Button } from '@scholaros/ui/components/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@scholaros/ui/components/field';
import { Switch } from '@scholaros/ui/components/switch';
import { Textarea } from '@scholaros/ui/components/textarea';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { toast } from '@scholaros/ui/components/toast';
import type { GradeSettings as GradeSettingsValue } from '@scholaros/services/learning/grade-contracts';
import { useConfirm } from '../../../hooks/use-confirm';
import { errorMessage } from '../../../lib/error-message';
import { formatGradeAccessStatus } from '../lib/formatters';

type GradeSettingsChange = {
  enabled: boolean;
  notes: string;
  deleteCollected?: boolean;
};

type GradeSettingsProps = {
  accountId: string;
  settings: GradeSettingsValue;
  onSave: (changes: GradeSettingsChange) => Promise<GradeSettingsValue | void>;
};

type GradeSettingsDraft = Pick<GradeSettingsValue, 'enabled' | 'notes'>;

export const GradeSettings = ({
  accountId,
  settings,
  onSave,
}: GradeSettingsProps) => {
  const [draft, setDraft] = useState<GradeSettingsDraft>(() => ({
    enabled: settings.enabled,
    notes: settings.notes,
  }));
  const [persistedSettings, setPersistedSettings] = useState(settings);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const previousAccountId = useRef(accountId);
  const confirmation = useConfirm<boolean>();
  const status = formatGradeAccessStatus(draft.enabled);

  useEffect(() => {
    if (previousAccountId.current !== accountId) {
      previousAccountId.current = accountId;
      setDraft({ enabled: settings.enabled, notes: settings.notes });
      setNotesError(null);
    }
    setPersistedSettings(settings);
  }, [accountId, settings]);

  const save = (nextDraft: GradeSettingsDraft) => {
    setDraft(nextDraft);
    setNotesError(null);
    void onSave(nextDraft)
      .then((savedSettings) => {
        if (savedSettings) setPersistedSettings(savedSettings);
      })
      .catch(() => undefined);
  };

  const deleteCollectedGrades = async () => {
    setDeleting(true);
    try {
      const savedSettings = await onSave({
        enabled: false,
        notes: draft.notes,
        deleteCollected: true,
      });
      setDraft({ enabled: false, notes: draft.notes });
      if (savedSettings) setPersistedSettings(savedSettings);
      confirmation.cancel();
    } catch (cause) {
      toast.error(
        errorMessage(cause, 'Could not delete collected grade data.'),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section
      aria-labelledby="grade-settings-title"
      className="flex w-full flex-col gap-5"
    >
      <FieldSet>
        <FieldLegend id="grade-settings-title" variant="label">
          School grades
        </FieldLegend>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="grade-access-switch">
              Use grades for study
            </FieldLabel>
            <FieldDescription>
              Grade access is off by default and uses only currently authorized
              course connections.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="grade-access-switch"
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              save({ ...draft, enabled: checked === true })
            }
          />
        </Field>
        <p
          className="flex items-center gap-2 text-base text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <status.Icon className="size-5" aria-hidden="true" />
          {status.label}
        </p>
        {draft.enabled && (
          <Field>
            <FieldLabel htmlFor="grade-access-notes">
              Additional access restrictions
            </FieldLabel>
            <FieldDescription id="grade-access-notes-help">
              Optional notes can narrow access; they never enable a connection
              or change coursework policy.
            </FieldDescription>
            <Textarea
              id="grade-access-notes"
              className="w-full"
              maxLength={2000}
              value={draft.notes}
              aria-describedby="grade-access-notes-help grade-access-notes-error"
              aria-invalid={notesError !== null}
              onChange={(event) => {
                const notes = event.target.value;
                setDraft({ ...draft, notes });
                if (notes.length > 2000) {
                  setNotesError('Use at most 2,000 characters.');
                  return;
                }
                setNotesError(null);
                save({ ...draft, notes });
              }}
            />
            {notesError && (
              <FieldError id="grade-access-notes-error">
                {notesError}
              </FieldError>
            )}
          </Field>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className="text-base text-muted-foreground">
            Collected grade records: {persistedSettings.collectedCount}
          </p>
          {persistedSettings.collectedCount > 0 && (
            <TooltipWrapper content="Delete collected grade data">
              <Button
                type="button"
                variant="destructive"
                size="icon"
                aria-label="Delete collected grade data"
                onClick={() => confirmation.request(true)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </TooltipWrapper>
          )}
        </div>
      </FieldSet>
      <AlertDialog
        open={!!confirmation.pending}
        onOpenChange={(open) => {
          if (!open && !deleting) confirmation.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete collected grade data?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes collected school grade evidence; course materials and
              app practice history are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              data-confirm-grade-deletion
              onClick={() => void deleteCollectedGrades()}
            >
              Delete collected grade data
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
