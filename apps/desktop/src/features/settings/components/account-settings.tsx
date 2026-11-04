import { useRouter } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { UserProfile } from '@scholaros/ui/components/user-profile';
import { useCurrentUser } from '../../dashboard/hooks/use-current-user';
import { useSignOut } from '../../dashboard/hooks/use-sign-out';

export const AccountSettings = () => {
  const account = useCurrentUser();
  const router = useRouter();
  const { signingOut, error, signOutNow } = useSignOut({
    signOut: () => window.scholar.signOut(),
    clearRendererState: account.clear,
    navigateToAuth: async () => {
      await router.invalidate();
      await router.navigate({ to: '/auth' });
    },
  });
  const user = account.user;
  return (
    <Card>
      <CardHeader>
        <CardTitle>ScholarOS account</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {account.loading ? (
          <p role="status">Loading account</p>
        ) : user ? (
          <div className="flex items-center gap-3">
            <UserProfile
              name={user.name.trim() || user.email}
              image={user.image}
              className="size-12"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium">{user.name.trim() || user.email}</p>
              <p className="break-all text-muted-foreground">{user.email}</p>
            </div>
          </div>
        ) : (
          <p>Sign in to view your account.</p>
        )}
        {(account.error || error) && (
          <p role="alert" className="text-destructive">
            {account.error || error}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          disabled={!user || signingOut}
          onClick={() => void signOutNow()}
        >
          <LoadingSwap isLoading={signingOut}>
            <LogOut className="size-4" />
            Log out
          </LoadingSwap>
        </Button>
      </CardContent>
    </Card>
  );
};
