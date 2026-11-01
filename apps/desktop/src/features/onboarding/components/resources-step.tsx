import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useEffect, useState } from 'react';
import { ConnectionNotesEditor } from './connection-notes-editor';
import { Check, ExternalLink, Link as LinkIcon, Trash2 } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { toast } from '@scholaros/ui/components/toast';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@scholaros/ui/components/combobox';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { academicResources, type AcademicResource } from '../constants';
import { formatConnectionStatus, formatResourceKind } from '../lib/formatters';
import type {
  AcademicConnection,
  OnboardingState,
  PreviewedConnection,
} from '../types';
import { Card, CardContent } from '@scholaros/ui/components/card';
import { Separator } from '@scholaros/ui/components/separator';

const resources: AcademicResource[] = [...academicResources];

type ResourcesStepProps = {
  state: OnboardingState;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  update: (state: OnboardingState) => void;
  showConnections?: boolean;
};

export const ResourcesStep = ({
  state,
  busy,
  run,
  update,
  showConnections = true,
}: ResourcesStepProps) => {
  const [resource, setResource] = useState<AcademicResource | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [addedSite, setAddedSite] = useState<AcademicConnection | null>(null);
  const [preview, setPreview] = useState<PreviewedConnection | null>(null);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const current = await window.scholar.previewResource();
        if (!disposed) setPreview(current);
      } catch {
        if (!disposed) setPreview(null);
      } finally {
        reading = false;
      }
    };
    void read();
    // Navigation happens in a separate browser, including when both windows
    // stay visible, so focus events alone cannot keep the label current.
    const timer = setInterval(() => void read(), 2_000);
    window.addEventListener('focus', read);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [state.accountId]);
  useEffect(() => {
    if (!addedSite) return;
    const timer = setTimeout(() => setAddedSite(null), 5_000);
    return () => clearTimeout(timer);
  }, [addedSite]);
  const act = async (actionId: string, action: () => Promise<void>) => {
    setPendingAction(actionId);
    try {
      await run(action);
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <div className="flex flex-col gap-6 @container">
      <Card>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <label
              htmlFor="school-search"
              className="font-medium text-xl font-serif"
            >
              Find your school or a learning service
            </label>
            <Combobox<AcademicResource>
              items={resources}
              value={resource}
              onValueChange={setResource}
              itemToStringLabel={(item) => `${item.name} ${item.service}`}
            >
              <ComboboxInput
                id="school-search"
                placeholder="Search your school, Canvas, Pearson…"
                className="w-full [&_input]:text-base"
              />
              <ComboboxContent>
                <ComboboxEmpty>
                  Not listed? Open the site in your study browser.
                </ComboboxEmpty>
                <ComboboxList>
                  {(item: AcademicResource) => (
                    <ComboboxItem
                      key={item.id}
                      value={item}
                      className="py-3 text-base"
                    >
                      <span className="flex flex-col">
                        <span>{item.name}</span>
                        <span className="text-muted-foreground">
                          {item.service}
                        </span>
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <Button
              className="self-start text-base w-full @3xl:w-auto"
              disabled={busy || !resource}
              onClick={() =>
                void act('open', async () => {
                  if (resource) await window.scholar.openResource(resource.id);
                })
              }
            >
              <LoadingSwap isLoading={pendingAction === 'open'}>
                <span className="flex items-center gap-2">
                  <ExternalLink className="size-5" />
                  Open in study browser
                </span>
              </LoadingSwap>
            </Button>
          </div>
          <div className="flex items-center gap-2 w-full min-w-0">
            <Separator className="flex-1" />
            <span className="text-lg text-muted-foreground font-medium">
              Or
            </span>
            <Separator className="flex-1" />
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h3 className="font-medium text-xl">
                Already have your course dashboard open?
              </h3>
              <p className="text-muted-foreground text-base max-w-250">
                Click the button below to open a new window in the agent's
                browser profile. Then navigate to an educational website you use
                and sign in. Come back here and click the same button below
                again to add that website as a resource for the agent to use.
              </p>
            </div>
            <Button
              variant="outline"
              className="self-start text-base w-full @3xl:w-auto"
              disabled={busy}
              onClick={() =>
                void act('capture', async () => {
                  const connection = await window.scholar.captureResource();
                  update(await window.scholar.getState());
                  setAddedSite(connection);
                  toast.success(`Added ${connection.name}`);
                })
              }
            >
              <LoadingSwap isLoading={pendingAction === 'capture'}>
                <span className="flex items-center gap-2">
                  <LinkIcon className="size-5 shrink-0" />
                  <span className="truncate">
                    {preview
                      ? `Connect "${preview.name}"`
                      : 'Start connecting resources'}
                  </span>
                </span>
              </LoadingSwap>
            </Button>
            {addedSite && (
              <p
                role="status"
                className="flex flex-wrap items-center gap-2 text-lg text-muted-foreground"
              >
                <Check className="size-5 shrink-0 text-primary" />
                Connected
                <span className="font-medium text-foreground">
                  {addedSite.name}
                </span>
                <span>{addedSite.host}</span>
                <span>{formatResourceKind(addedSite.kind).label}</span>
                <span>{formatConnectionStatus(addedSite.status).label}</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      {showConnections && (
        <div className="flex flex-col gap-3">
          {state.connections.length === 0 && (
            <p className="text-muted-foreground">No resources connected yet.</p>
          )}
          {state.connections.map((connection) => {
            const status = formatConnectionStatus(connection.status);
            const resourceKind = formatResourceKind(connection.kind);
            return (
              <div
                key={connection.id}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  <resourceKind.Icon className="mt-1 size-5 shrink-0 text-primary" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="truncate font-medium">{connection.name}</p>
                    <p className="truncate text-muted-foreground">
                      {connection.host}
                    </p>
                  </div>
                  <TooltipWrapper content="Remove resource">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${connection.name}`}
                      disabled={busy}
                      onClick={() =>
                        void act(`remove:${connection.id}`, async () => {
                          update(
                            await window.scholar.removeResource(connection.id),
                          );
                        })
                      }
                    >
                      <Trash2 className="size-5" />
                    </Button>
                  </TooltipWrapper>
                </div>
                <ConnectionNotesEditor
                  id={connection.id}
                  notes={connection.notes}
                  save={async (id, notes) => {
                    await window.scholar.saveConnectionNotes(id, notes);
                  }}
                />
                <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                  <status.Icon className="size-5" />
                  <span>{status.label}</span>
                  {connection.status === 'needs-sign-in' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(`confirm:${connection.id}`, async () => {
                          update(
                            await window.scholar.confirmResource(connection.id),
                          );
                        })
                      }
                    >
                      <Check className="size-4" />
                      I’m signed in
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showConnections && (
        <p className="text-muted-foreground text-base">
          Connect resources such as your school portal, textbooks, and reference
          sites so your agent can use them to find study materials.
        </p>
      )}
    </div>
  );
};
