import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import {
  Check,
  CircleAlert,
  FilterIcon,
  Globe,
  Loader2,
  PlusIcon,
  Trash2,
} from "lucide-react";
import { Button } from "@scholaros/ui/components/button";
import { Input } from "@scholaros/ui/components/input";
import { Switch } from "@scholaros/ui/components/switch";
import { Card, CardContent } from "@scholaros/ui/components/card";
import { Alert, AlertDescription } from "@scholaros/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@scholaros/ui/components/alert-dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@scholaros/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@scholaros/ui/components/select";
import { PageHeading } from "../../../features/dashboard/page-heading";
import {
  connectionKindFilters,
  connectionSearchSchema,
  connectionStatusFilters,
  filterConnections,
  type ConnectionKindFilter,
  type ConnectionStatusFilter,
} from "../../../features/dashboard/lib/connection-filters";
import {
  formatConnectionKindFilter,
  formatConnectionStatusFilter,
} from "../../../features/dashboard/lib/formatters";
import { useOnboardingState } from "../../../features/onboarding/hooks/use-onboarding-state";
import { useBridgeAction } from "../../../hooks/use-bridge-action";
import { useConfirm } from "../../../hooks/use-confirm";
import { ConnectionNotesEditor } from "../../../features/onboarding/components/connection-notes-editor";
import {
  formatConnectionStatus,
  formatResourceKind,
} from "../../../features/onboarding/lib/formatters";
import type { AcademicConnection } from "../../../features/onboarding/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@scholaros/ui/components/tooltip";

const ConnectionsPage = () => {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q);
  const {
    pending: removing,
    request: requestRemoval,
    cancel: cancelRemoval,
  } = useConfirm<AcademicConnection>();
  const { state, setState, updateConnectionNotes, loading, loadError, reload } =
    useOnboardingState();
  const { busy, error, run } = useBridgeAction();
  useEffect(() => setQuery(search.q), [search.q]);
  const pushQuery = useDebouncedCallback(
    (value: string) => {
      if (value === search.q) return;
      void navigate({
        search: (previous) => ({ ...previous, q: value }),
        replace: true,
      });
    },
    { wait: 250 },
  );
  useEffect(
    () =>
      window.scholar.onConnectChange((run) => {
        if (
          run.accountId === state?.accountId &&
          ["complete", "cancelled", "blocked"].includes(run.status)
        )
          void reload();
      }),
    [state?.accountId, reload],
  );
  const filtered = state ? filterConnections(state.connections, search) : [];
  return (
    <div className="flex flex-col gap-6 @container">
      <PageHeading page="connections">
        <Button
          nativeButton={false}
          render={<Link to="/dashboard/connections/add" />}
        >
          <PlusIcon />
          New Connection
        </Button>
      </PageHeading>
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
        <>
          <div className="flex w-full min-w-0 gap-3">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                pushQuery(event.target.value);
              }}
              placeholder="Search connections by name, url, or notes"
              className="w-full min-w-0 flex-1"
            />
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Connection filters"
                  />
                }
              >
                <FilterIcon />
              </PopoverTrigger>
              <PopoverContent className="flex flex-col gap-4" align="end">
                <label className="flex flex-1 flex-col gap-1">
                  Status
                  <Select
                    value={search.status}
                    onValueChange={(value) =>
                      value &&
                      void navigate({
                        search: (previous) => ({
                          ...previous,
                          status: value as ConnectionStatusFilter,
                        }),
                        replace: true,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {formatConnectionStatusFilter(search.status).label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {connectionStatusFilters.map((filter) => {
                        const option = formatConnectionStatusFilter(filter);
                        return (
                          <SelectItem key={filter} value={filter}>
                            <div className="flex items-center gap-2">
                              <option.Icon className="size-4" />
                              {option.label}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-1 flex-col gap-1">
                  Kind
                  <Select
                    value={search.kind}
                    onValueChange={(value) =>
                      value &&
                      void navigate({
                        search: (previous) => ({
                          ...previous,
                          kind: value as ConnectionKindFilter,
                        }),
                        replace: true,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {formatConnectionKindFilter(search.kind).label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {connectionKindFilters.map((filter) => {
                        const option = formatConnectionKindFilter(filter);
                        return (
                          <SelectItem key={filter} value={filter}>
                            <div className="flex items-center gap-2">
                              <option.Icon className="size-4" />
                              {option.label}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </label>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex flex-col gap-3">
            {filtered.length === 0 && (
              <p>No connections match these filters.</p>
            )}
            {filtered.map((connection) => {
              const status = formatConnectionStatus(connection.status);
              const kind = formatResourceKind(connection.kind);
              return (
                <Card key={connection.id} size="sm" className="text-base">
                  <CardContent data-slot="connection-card">
                    <div className="flex items-center gap-2">
                      <div className="size-11 rounded-full bg-muted border flex items-center justify-center">
                        {connection.favicon ? (
                          <img
                            src={connection.favicon}
                            alt=""
                            className="size-5 shrink-0 rounded-sm object-contain"
                          />
                        ) : (
                          <Globe className="size-5 shrink-0" />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col">
                        <div className="flex items-center gap-3">
                          <p>{connection.name}</p>
                          <div className="flex items-center gap-2">
                            <Tooltip>
                              <TooltipTrigger>
                                <kind.Icon className="size-4" />
                              </TooltipTrigger>
                              <TooltipContent>{kind.label}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger>
                                <status.Icon className="size-4" />
                              </TooltipTrigger>
                              <TooltipContent>{status.label}</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                        <p className="text-muted-foreground">
                          {connection.host}
                        </p>
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove connection"
                        aria-label={`Remove ${connection.name}`}
                        disabled={busy}
                        onClick={() => requestRemoval(connection)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {connection.status === "needs-sign-in" && (
                      <Button
                        variant="outline"
                        className="self-start"
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            setState(
                              await window.scholar.confirmResource(
                                connection.id,
                              ),
                            ),
                          )
                        }
                      >
                        <Check />
                        I’m signed in
                      </Button>
                    )}
                    <ConnectionNotesEditor
                      id={connection.id}
                      notes={connection.notes}
                      save={async (id, notes) => {
                        await window.scholar.saveConnectionNotes(id, notes);
                        updateConnectionNotes(id, notes.trim());
                      }}
                    />
                    <div className="flex items-center justify-between @3xl:justify-start gap-4">
                      <div className="flex flex-col">
                        <label
                          htmlFor={`course-resource-${connection.id}`}
                          className="font-medium cursor-pointer"
                        >
                          Course resource
                        </label>
                        <p className="text-muted-foreground">
                          Find courses from this site.
                        </p>
                        {connection.isCourseResource &&
                          connection.status === "needs-sign-in" && (
                            <p className="flex items-center gap-2 text-muted-foreground">
                              <CircleAlert className="size-4 shrink-0" />
                              Sign in here before courses can refresh.
                            </p>
                          )}
                      </div>
                      <Switch
                        id={`course-resource-${connection.id}`}
                        className="shrink-0 cursor-pointer"
                        checked={connection.isCourseResource === true}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          void run(async () =>
                            setState(
                              await window.scholar.setCourseResource(
                                connection.id,
                                checked === true,
                              ),
                            ),
                          )
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <AlertDialog
            open={!!removing}
            onOpenChange={(open) => {
              if (!open) cancelRemoval();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the connection and its local notes.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const id = removing?.id;
                    cancelRemoval();
                    if (id)
                      void run(async () =>
                        setState(await window.scholar.removeResource(id)),
                      );
                  }}
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
};

export const Route = createFileRoute("/dashboard/connections/")({
  validateSearch: connectionSearchSchema,
  component: ConnectionsPage,
});
