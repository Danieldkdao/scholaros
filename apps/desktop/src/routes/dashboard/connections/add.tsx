import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@scholaros/ui/components/breadcrumb';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@scholaros/ui/components/tabs';
import { ConnectRunPanel } from '../../../features/dashboard/connect-run-panel';
import { ConnectionFinder } from '../../../features/dashboard/connection-finder';
import { defaultConnectionSearch } from '../../../features/dashboard/lib/connection-filters';
import { formatDashboardPage } from '../../../features/dashboard/lib/formatters';
import { ResourcesStep } from '../../../features/onboarding/components/resources-step';
import { useOnboardingState } from '../../../features/onboarding/hooks/use-onboarding-state';
import { useBridgeAction } from '../../../hooks/use-bridge-action';

const pageTitle = 'Add New Connection';

const ConnectionAddPage = () => {
  const { state, setState, loading, loadError, reload } = useOnboardingState();
  const { busy, error, run } = useBridgeAction();
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink
              render={
                <Link
                  to="/dashboard/connections"
                  search={defaultConnectionSearch}
                />
              }
            >
              {formatDashboardPage('connections').title}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <h1 className="text-3xl font-semibold">{pageTitle}</h1>
      {loading && (
        <Loader2
          role="status"
          aria-label="Loading connections"
          className="size-6 animate-spin"
        />
      )}
      {loadError && (
        <Alert>
          <AlertDescription>{loadError}</AlertDescription>
          <Button onClick={() => void reload()}>Retry</Button>
        </Alert>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {state && (
        <Tabs defaultValue="manual">
          <TabsList className="w-full">
            <TabsTrigger value="manual">Manual</TabsTrigger>
            <TabsTrigger value="auto">Auto</TabsTrigger>
          </TabsList>
          <TabsContent value="manual">
            <ResourcesStep
              state={state}
              busy={busy}
              run={run}
              update={setState}
              showConnections={false}
            />
          </TabsContent>
          <TabsContent value="auto">
            <ConnectionFinder />
          </TabsContent>
        </Tabs>
      )}
      <ConnectRunPanel />
    </div>
  );
};

export const Route = createFileRoute('/dashboard/connections/add')({
  component: ConnectionAddPage,
});
