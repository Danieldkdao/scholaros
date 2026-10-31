import { useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { Button } from "@scholaros/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@scholaros/ui/components/dialog";
import { toast } from "@scholaros/ui/components/toast";
import { Input } from "@scholaros/ui/components/input";
import { LoadingSwap } from "@scholaros/ui/components/loading-swap";
import { Separator } from "@scholaros/ui/components/separator";
import { Textarea } from "@scholaros/ui/components/textarea";
import { isAcademicUrl } from "../onboarding/lib/browser-policy";
import { errorMessage } from "../../lib/error-message";
import type { ConnectionProposal } from "../onboarding/types";
import { Card, CardContent } from "@scholaros/ui/components/card";

type ReviewEntryProps = {
  Icon: typeof Globe;
  title: string;
  detail: string;
  removeLabel: string;
  busy: boolean;
  onRemove: () => void;
};

const ReviewEntry = ({
  Icon,
  title,
  detail,
  removeLabel,
  busy,
  onRemove,
}: ReviewEntryProps) => (
  <div
    data-slot="review-entry"
    className="flex min-w-0 items-center gap-3 py-3"
  >
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-5" />
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      <span data-slot="review-line" className="truncate text-base font-medium">
        {title}
      </span>
      <span
        data-slot="review-line"
        className="truncate text-base text-muted-foreground"
      >
        {detail}
      </span>
    </div>
    <Button
      variant="destructive"
      size="icon-sm"
      aria-label={removeLabel}
      disabled={busy}
      onClick={onRemove}
    >
      <Trash2 />
    </Button>
  </div>
);

export const ConnectionFinder = () => {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ConnectionProposal | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [site, setSite] = useState("");
  const [approved, setApproved] = useState(false);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, "Could not update sites; try again."));
    } finally {
      setBusy(false);
    }
  };
  const resolve = () =>
    perform(async () => {
      setProposal(null);
      setApproved(false);
      setReviewing(false);
      const next = await window.scholar.resolveConnections(prompt);
      if (!next.candidates.length) {
        toast.error(
          "No sites found; try a more specific subject, learning service, or school.",
        );
        return;
      }
      setProposal(next);
      setReviewing(true);
    });
  const revise = (next: ConnectionProposal) =>
    perform(async () => {
      setApproved(false);
      setProposal(await window.scholar.reviseConnectionProposal(next));
    });
  const addSite = () => {
    if (!proposal) return;
    let host: string;
    try {
      const value = site.trim();
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (!isAcademicUrl(url.href)) throw new Error("Invalid site address");
      host = url.hostname;
    } catch {
      setError(
        "Enter a website address such as school.edu or https://school.edu.",
      );
      return;
    }
    void revise({
      ...proposal,
      candidates: [
        ...proposal.candidates,
        { name: host, url: `https://${host}/`, provider: "unknown" },
      ],
    });
    setSite("");
  };
  return (
    <>
      <Card className="@container">
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium text-xl">Find a site</h2>
            <label
              htmlFor="connection-request"
              className="text-muted-foreground text-base"
            >
              Name a subject, learning service, or school; your request is sent
              to an AI provider to suggest sites for you to verify.
            </label>
          </div>
          {/* The Textarea primitive drops to text-sm at md widths, so both edges
              need the larger size or the field shrinks inside the app window. */}
          <Textarea
            id="connection-request"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Math practice websites, Khan Academy, or my school’s Canvas portal"
            className="text-base md:text-base"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !prompt.trim()}
              onClick={() => void resolve()}
              className="text-base"
            >
              <LoadingSwap isLoading={busy}>Find sites</LoadingSwap>
            </Button>
            {proposal && !reviewing && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setReviewing(true)}
                className="text-base"
              >
                Review sites
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-base">
              {error}
            </p>
          )}
          {approved && (
            <p role="status" className="text-base">
              Your connection run has started.
            </p>
          )}
        </CardContent>
      </Card>
      <Dialog open={!!proposal && reviewing} onOpenChange={setReviewing}>
        {proposal && (
          <DialogContent className="flex max-h-[80svh] w-full max-w-lg flex-col gap-0 p-0 sm:max-w-lg">
            <DialogHeader className="gap-2 px-6 pt-6 pb-2">
              <DialogTitle className="text-xl">
                Review sites to connect
              </DialogTitle>
              <DialogDescription className="text-base">
                Page text and notes from approved sites are shared with the AI
                provider.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6">
              {proposal.candidates.map((candidate, index) => (
                <div key={candidate.url} className="min-w-0">
                  {index > 0 && <Separator />}
                  <ReviewEntry
                    Icon={Globe}
                    title={candidate.name}
                    detail={new URL(candidate.url).hostname}
                    removeLabel={`Remove ${candidate.name}`}
                    busy={busy}
                    onRemove={() =>
                      void revise({
                        ...proposal,
                        candidates: proposal.candidates.filter(
                          (item) => item.url !== candidate.url,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <DialogFooter className="border-t p-4 w-full flex flex-col gap-4 md:flex-col">
              {error && (
                <p role="alert" className="text-base text-destructive">
                  {error}
                </p>
              )}
              <div className="flex gap-2 w-full">
                <Input
                  aria-label="Destination site address"
                  value={site}
                  onChange={(event) => setSite(event.target.value)}
                  placeholder="school.edu or https://school.edu/course"
                  className="min-w-0 flex-1 text-base md:text-base"
                />
                <Button
                  size="icon"
                  aria-label="Add destination site"
                  disabled={busy || !site.trim()}
                  onClick={addSite}
                >
                  <Plus />
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <DialogClose render={<Button variant="ghost" />}>
                  Cancel
                </DialogClose>
                <Button
                  disabled={busy || approved || !proposal.candidates.length}
                  onClick={() =>
                    void perform(async () => {
                      await window.scholar.approveConnectionProposal(proposal);
                      try {
                        await window.scholar.startConnectRun(proposal.id);
                        setApproved(true);
                        setReviewing(false);
                      } catch (cause) {
                        setProposal(null);
                        throw new Error(
                          `${errorMessage(cause, "Could not start the run.")} Find sites again to retry.`,
                        );
                      }
                    })
                  }
                >
                  <LoadingSwap isLoading={busy}>Approve sites</LoadingSwap>
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};
