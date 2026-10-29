import { MessageSquare } from 'lucide-react';
import { Textarea } from '@scholaros/ui/components/textarea';

type ContextStepProps = {
  notes: string;
  busy: boolean;
  onNotesChange: (notes: string) => void;
  onNotesBlur: () => void;
};

export const ContextStep = ({
  notes,
  busy,
  onNotesBlur,
  onNotesChange,
}: ContextStepProps) => {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-start flex-wrap gap-3 w-full">
          <MessageSquare className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex flex-col gap-2 flex-1 min-w-0">
            <div className="flex flex-col gap-1">
              <label htmlFor="academic-notes" className="font-medium">
                Anything else you’d like ScholarOS to know?
              </label>
              <p className="text-muted-foreground max-w-164 w-full">
                Optional. This information will not grant access to other sites,
                it will simply help the agent understand your needs and
                structure better.
              </p>
            </div>
            <Textarea
              id="academic-notes"
              value={notes}
              maxLength={2000}
              rows={4}
              disabled={busy}
              onChange={(event) => onNotesChange(event.target.value)}
              onBlur={onNotesBlur}
              placeholder="For example: my biology course uses a separate lab site."
              className="min-h-28"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
