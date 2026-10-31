import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDownIcon,
  FolderOpen,
  Globe,
  Loader2,
  LogInIcon,
  RefreshCw,
  ScanSearchIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { cn } from '@scholaros/ui/lib/utils';
import { formatBrowser, formatWorkspaceStatus } from '../lib/formatters';
import type { BrowserInstallation, OnboardingState } from '../types';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@scholaros/ui/components/collapsible';

type BrowserStepProps = {
  state: OnboardingState;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  update: (state: OnboardingState) => void;
};

export const BrowserStep = ({ state, busy, run, update }: BrowserStepProps) => {
  const [browsers, setBrowsers] = useState<BrowserInstallation[]>([]);
  const [searching, setSearching] = useState(true);
  const refresh = async () => {
    setSearching(true);
    try {
      setBrowsers(await window.scholar.findBrowsers());
    } finally {
      setSearching(false);
    }
  };
  useEffect(() => {
    void run(refresh);
  }, []);
  const workspaceStatus = state.workspace
    ? formatWorkspaceStatus(state.workspace.status)
    : null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground">
          Supported browsers on this computer
        </p>
        <Button
          variant="ghost"
          size="icon"
          title="Find browsers again"
          aria-label="Find browsers again"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          <RefreshCw className={cn('size-5', searching && 'animate-spin')} />
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {browsers.map((browser) => {
          const { Icon } = formatBrowser(browser.browser);
          const selected = state.workspace?.browser === browser.browser;
          return (
            <button
              key={browser.id}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  update(await window.scholar.createWorkspace(browser.id)),
                )
              }
              className={cn(
                'cursor-pointer flex w-full items-center gap-4 rounded-xl border bg-card p-5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md disabled:pointer-events-none disabled:opacity-60 motion-reduce:transform-none',
                selected && 'border-primary bg-accent',
              )}
            >
              {browser.icon ? (
                <img
                  src={browser.icon}
                  alt=""
                  className="size-12 object-contain"
                />
              ) : (
                <Icon className="size-10 text-primary" />
              )}
              <span className="flex flex-1 flex-col gap-1">
                <span className="font-medium">{browser.name}</span>
                <span className="text-muted-foreground">{browser.version}</span>
              </span>
              {selected && <Check className="size-5 text-primary" />}
            </button>
          );
        })}
      </div>
      {!searching && !browsers.length && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-muted-foreground">
          <Globe className="size-6" />
          <p>
            No supported browser found; choose an installed Chrome, Edge, or
            Brave application.
          </p>
        </div>
      )}
      <Button
        variant="outline"
        className="self-start text-base"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const browser = await window.scholar.chooseBrowser();
            if (!browser) return;
            setBrowsers((previous) =>
              previous.some((item) => item.id === browser.id)
                ? previous
                : [...previous, browser],
            );
            update(await window.scholar.createWorkspace(browser.id));
          })
        }
      >
        <FolderOpen className="size-5" />
        Choose browser location
      </Button>
      {busy && (
        <p
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Loader2 className="size-5 animate-spin" />
          Preparing your separate study browser…
        </p>
      )}
      {state.workspace?.ready && workspaceStatus && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl bg-muted p-4"
        >
          <workspaceStatus.Icon className="size-5 text-primary" />
          <p>{state.workspace.browserName} study workspace is ready.</p>
        </div>
      )}
      {state.workspace && !state.workspace.ready && workspaceStatus && (
        <p role="alert" className="flex items-center gap-2 text-destructive">
          <workspaceStatus.Icon className="size-5" />
          {workspaceStatus.description}
        </p>
      )}
      <Collapsible className="mt-2 w-full rounded-lg bg-muted/50">
        <CollapsibleTrigger className="group/more-info flex w-full cursor-pointer items-center justify-between gap-2 font-medium">
          <span>Why do I need to do this?</span>
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-panel-open/more-info:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-3 text-muted-foreground">
          <p>
            ScholarOS finds your deadlines and readings by opening your course
            pages the same way you do — most schools offer no way to read that
            data without signing in, so the agent needs a real browser to work
            in. Choosing one here just tells ScholarOS which browser app to
            launch; it never takes over the window you browse with every day.
          </p>
          <p className="font-medium text-foreground">
            That browser does three jobs:
          </p>
          <ul className="flex flex-col gap-2">
            <li className="flex items-start gap-2">
              <LogInIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Sign in once, on your school’s own page, including SSO or MFA —
                your password is typed there, never here.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ScanSearchIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Let your agent revisit connected resources and read study
                materials, announcements, and assigned work without another
                sign-in.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                Hold a study-only session, so the agent has course access while
                personal logins, bookmarks, and history stay out of reach.
              </span>
            </li>
          </ul>
          <p>
            Pick whichever browser you already trust with schoolwork; you’ll
            sign in inside a normal window you can watch or steer at any time.
            Removing a connected site, or the whole study workspace, clears only
            that academic session.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
