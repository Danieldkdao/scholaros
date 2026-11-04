import { useState } from 'react';
import { HardDrive, Trash2 } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@scholaros/ui/components/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { useConfirm } from '../../../hooks/use-confirm';
import { errorMessage } from '../../../lib/error-message';

export type DeleteLocalData = (input: { requestId: string }) => Promise<void>;

type LocalDataSettingsProps = {
  deleteLocalData?: DeleteLocalData;
  onDeleted?: () => void;
};

export const LocalDataSettings = ({
  deleteLocalData,
  onDeleted,
}: LocalDataSettingsProps) => {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmation = useConfirm<boolean>();

  const removeLocalData = async () => {
    if (!confirmation.pending || !deleteLocalData) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteLocalData({ requestId: window.crypto.randomUUID() });
      confirmation.cancel();
      onDeleted?.();
    } catch (cause) {
      setError(errorMessage(cause, 'Could not remove local data.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="local-data-title">
      <div className="flex flex-col gap-1">
        <h3 id="local-data-title" className="text-lg font-medium">
          Local data
        </h3>
        <p className="text-base text-muted-foreground">
          Choose what to remove without confusing local study records with your
          ScholarOS account.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Remove collected grades only</CardTitle>
          <CardDescription>
            Grade-only removal keeps course materials and practice.
            Independently saved memories and activities have their own controls.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/dashboard/settings"
            search={{ section: 'grades' }}
            className="text-base text-primary underline underline-offset-4"
          >
            Open grade access settings
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Remove local academic data</CardTitle>
          <CardDescription>
            Full removal includes courses, study sessions, grades, memories,
            saved activities and the dedicated study browser profile. Deleting
            an individual session does not remove separately saved memories or
            activities.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            disabled={!deleteLocalData || deleting}
            onClick={() => confirmation.request(true)}
          >
            <Trash2 className="size-4" />
            Review local data removal
          </Button>
          {!deleteLocalData && (
            <p className="text-base text-muted-foreground">
              Local data removal is unavailable until the product adapter is
              connected.
            </p>
          )}
        </CardContent>
      </Card>
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirmation.pending === true}
        onOpenChange={(open) => {
          if (!open && !deleting) confirmation.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mb-2 flex size-12 items-center justify-center rounded-lg bg-muted">
              <HardDrive className="size-6 text-muted-foreground" />
            </div>
            <AlertDialogTitle>Remove local academic data?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes this device’s academic records and study
              browser profile, including separately saved memories and
              activities. This does not delete your ScholarOS account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void removeLocalData();
              }}
            >
              <LoadingSwap isLoading={deleting}>Remove local data</LoadingSwap>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
