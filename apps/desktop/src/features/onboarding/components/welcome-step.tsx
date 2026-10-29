import {
  BookOpen,
  ChevronDownIcon,
  Cloud,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { Checkbox } from '@scholaros/ui/components/checkbox';
import { academicDisclosure } from '../constants';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@scholaros/ui/components/collapsible';

type WelcomeStepProps = {
  consent: boolean;
  busy: boolean;
  onConsentChange: (checked: boolean) => void;
};

export const WelcomeStep = ({
  consent,
  busy,
  onConsentChange,
}: WelcomeStepProps) => (
  <div className="flex flex-col gap-5">
    <div className="flex flex-wrap gap-4">
      <div className="flex min-w-60 flex-1 flex-col gap-2 rounded-xl border bg-card p-5">
        <BookOpen className="size-5 text-primary" />
        <p className="font-medium">Only what you connect</p>
        <p className="text-muted-foreground">
          ScholarOS reads the academic sites you choose, never your personal
          browsing.
        </p>
      </div>
      <div className="flex min-w-60 flex-1 flex-col gap-2 rounded-xl border bg-card p-5">
        <LockKeyhole className="size-5 text-primary" />
        <p className="font-medium">Your sign-ins stay yours</p>
        <p className="text-muted-foreground">
          You sign in on the real academic website; ScholarOS never sees your
          password.
        </p>
      </div>
      <div className="flex min-w-60 flex-1 flex-col gap-2 rounded-xl border bg-card p-5">
        <ShieldCheck className="size-5 text-primary" />
        <p className="font-medium">Read-only missions</p>
        <p className="text-muted-foreground">
          The agent cannot submit work, send messages, make purchases, or change
          an account.
        </p>
      </div>
    </div>
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <Cloud className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <p className="font-medium">How your academic content is shared</p>
          <p>{academicDisclosure}</p>
          <Collapsible className="rounded-lg bg-muted/50 w-full mt-2">
            <CollapsibleTrigger className="cursor-pointer font-medium group/more-info flex items-center gap-2 justify-between w-full">
              <span className="font-medium">
                More about local storage and cloud processing
              </span>
              <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-panel-open/more-info:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3 text-muted-foreground">
              <p>
                Your study browser profile, academic sessions, connected sites,
                notes, and study history stay on this computer by default.
              </p>
              <p>
                When the agent needs to understand a page, relevant excerpts are
                sent to cloud language models: one interprets the content, and
                another chooses the next permitted page. This is cloud
                processing, not local inference.
              </p>
              <p>
                ScholarOS does not store academic passwords and does not write
                academic content to cloud logs by default.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
    <label
      htmlFor="onboarding-consent"
      className="flex items-start gap-3 rounded-xl border bg-card p-5"
    >
      <Checkbox
        id="onboarding-consent"
        checked={consent}
        disabled={busy}
        onCheckedChange={(checked) => onConsentChange(checked === true)}
        className="mt-1"
      />
      <span className="flex flex-col gap-1 cursor-pointer">
        <span className="font-medium">
          I understand and allow ScholarOS to read the academic resources I
          connect.
        </span>
        <span className="text-muted-foreground">
          You can disconnect a resource or stop background work at any time.
        </span>
      </span>
    </label>
  </div>
);
