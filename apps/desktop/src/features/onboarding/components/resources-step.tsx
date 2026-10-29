import { useState } from 'react';
import { Check, ExternalLink, Link as LinkIcon, Trash2 } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
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
import type { OnboardingState } from '../types';

const resources: AcademicResource[] = [...academicResources];

type ResourcesStepProps = {
  state: OnboardingState;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  update: (state: OnboardingState) => void;
};

export const ResourcesStep = ({
  state,
  busy,
  run,
  update,
}: ResourcesStepProps) => {
  const [resource, setResource] = useState<AcademicResource | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const act = async (actionId: string, action: () => Promise<void>) => {
    setPendingAction(actionId);
    try {
      await run(action);
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label htmlFor="school-search" className="font-medium">
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
            className="w-full text-base"
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
          className="self-start text-base"
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
      <div className="flex flex-col gap-4 rounded-xl border bg-muted/40 p-5">
        <p className="font-medium">Already have your course dashboard open?</p>
        <p className="text-muted-foreground">
          Click the button below to open a new window in the agent's browser
          profile. Then navigate to an educational website you use and sign in.
          Come back here and click the same button below again to add that
          website as a resource for the agent to use.
        </p>
        <Button
          variant="outline"
          className="self-start text-base"
          disabled={busy}
          onClick={() =>
            void act('capture', async () => {
              await window.scholar.captureResource();
              update(await window.scholar.getState());
            })
          }
        >
          <LoadingSwap isLoading={pendingAction === 'capture'}>
            <span className="flex items-center gap-2">
              <LinkIcon className="size-5" />
              Connect this site
            </span>
          </LoadingSwap>
        </Button>
      </div>
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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${connection.name}`}
                  title="Remove resource"
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
              </div>
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
      <p className="text-muted-foreground">
        Your classes live spread across a few sites: the LMS, a school portal,
        maybe a textbook. ScholarOS can only read the ones you connect here, so
        this list is the whole world your agent can see. With each one signed
        in, it revisits those course pages to keep your classes, due dates, and
        announcements current instead of asking you to retype them.
      </p>
    </div>
  );
};
