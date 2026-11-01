import { Link, useRouter } from '@tanstack/react-router';
import { ChevronsUpDown, LogOut, RefreshCw, Settings } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  SidebarMenuButton,
  SidebarMenuSkeleton,
  useSidebar,
} from '@scholaros/ui/components/sidebar';
import { UserProfile } from '@scholaros/ui/components/user-profile';
import { useCurrentUser } from './hooks/use-current-user';
import { useSignOut } from './hooks/use-sign-out';

type AccountIdentityProps = {
  name: string;
  email: string | null;
  image: string | null;
};

const AccountIdentity = ({ name, email, image }: AccountIdentityProps) => (
  <>
    <UserProfile
      name={name}
      image={image}
      className="size-10 group-data-[collapsible=icon]:size-7"
      textClassName="group-data-[collapsible=icon]:text-base"
    />
    <div className="flex min-w-0 flex-1 flex-col text-left leading-tight group-data-[collapsible=icon]:hidden">
      <span className="truncate text-base font-medium">{name}</span>
      {email && (
        <span className="truncate text-base text-muted-foreground">
          {email}
        </span>
      )}
    </div>
  </>
);

export const ProfileMenu = () => {
  const router = useRouter();
  const { state, isMobile } = useSidebar();
  const account = useCurrentUser();
  const { signingOut, error, signOutNow } = useSignOut({
    signOut: () => window.scholar.signOut(),
    clearRendererState: account.clear,
    navigateToAuth: async () => {
      await router.invalidate();
      await router.navigate({ to: '/auth' });
    },
  });

  if (account.loading) return <SidebarMenuSkeleton showIcon />;

  const collapsed = state === 'collapsed' && !isMobile;
  // A blank display name falls back to the email so the avatar shows no invented initial.
  const name = account.user
    ? account.user.name.trim() || account.user.email
    : 'Account';
  const failure = account.error ?? error;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={name}
            aria-label={collapsed ? 'Account menu' : undefined}
            className="cursor-pointer data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground h-16 group-data-[collapsible=icon]:justify-center"
          />
        }
      >
        <AccountIdentity
          name={name}
          email={account.user?.email ?? null}
          image={account.user?.image ?? null}
        />
        <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-auto min-w-64 text-base"
      >
        <div className="flex items-center gap-2 p-2">
          <AccountIdentity
            name={name}
            email={account.user?.email ?? null}
            image={account.user?.image ?? null}
          />
        </div>
        <DropdownMenuSeparator />
        {failure && (
          <p role="alert" className="px-2 py-1.5 text-base text-destructive">
            {failure}
          </p>
        )}
        {account.error && (
          <DropdownMenuItem onClick={() => void account.reload()}>
            <RefreshCw />
            Try again
          </DropdownMenuItem>
        )}
        <DropdownMenuItem render={<Link to="/dashboard/settings" />}>
          <Settings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          closeOnClick={false}
          disabled={signingOut}
          onClick={() => void signOutNow()}
        >
          <LoadingSwap isLoading={signingOut}>
            <span className="flex items-center gap-2">
              <LogOut className="size-4" />
              Log out
            </span>
          </LoadingSwap>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
