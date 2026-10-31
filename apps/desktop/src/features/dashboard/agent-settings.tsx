import { useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react';
import { Input } from '@scholaros/ui/components/input';
import { Textarea } from '@scholaros/ui/components/textarea';
import { settingsUpdateSchema } from '../onboarding/schemas';
import { errorMessage } from '../../lib/error-message';
import type { SettingsUpdateSchema } from '../onboarding/schemas';

type SaveStatus = 'saving' | 'saved' | 'error';

const formatSaveStatus = (status: SaveStatus) => {
  switch (status) {
    case 'saving':
      return { label: 'Saving settings', Icon: Loader2 };
    case 'saved':
      return { label: 'Settings saved', Icon: CircleCheck };
    case 'error':
      return { label: 'Could not save settings', Icon: CircleAlert };
  }
};

export const AgentSettings = ({
  decisionTimeSeconds,
  blockedWords,
  onSave,
}: {
  decisionTimeSeconds: number;
  blockedWords: string[];
  onSave: (changes: SettingsUpdateSchema) => Promise<void>;
}) => {
  const [seconds, setSeconds] = useState(String(decisionTimeSeconds));
  const [words, setWords] = useState(blockedWords.join('\n'));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [failure, setFailure] = useState<string | null>(null);
  const [wordsError, setWordsError] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const validTime = settingsUpdateSchema.safeParse({
    decisionTimeSeconds: Number(seconds),
  }).success;
  const save = (changes: SettingsUpdateSchema) => {
    const current = ++revision.current;
    setStatus('saving');
    setFailure(null);
    // Keep queued writes alive after this page closes and prevent older edits winning.
    queue.current = queue.current.then(async () => {
      try {
        await onSave(changes);
        if (current === revision.current) setStatus('saved');
      } catch (error) {
        if (current === revision.current) {
          setStatus('error');
          setFailure(errorMessage(error, 'Could not save settings.'));
        }
      }
    });
  };
  const { label, Icon } = formatSaveStatus(status);
  return (
    <div className="flex items-start gap-8">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="decision-time" className="font-medium">
            Agent decision time in seconds
          </label>
          <p id="decision-help" className="text-base text-muted-foreground">
            Lower values speed up browsing; increase this if your school limits
            requests.
          </p>
          <Input
            id="decision-time"
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            className="w-full text-base"
            value={seconds}
            aria-describedby="decision-help decision-error"
            aria-invalid={!validTime}
            onChange={(event) => {
              const value = event.target.value;
              setSeconds(value);
              const parsed = settingsUpdateSchema.safeParse({
                decisionTimeSeconds: Number(value),
              });
              if (parsed.success) save(parsed.data);
            }}
          />
          {!validTime && (
            <p
              id="decision-error"
              role="alert"
              className="text-base text-destructive"
            >
              Use a time greater than zero and at most five seconds.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="blocked-words" className="font-medium">
            Blocked URL words
          </label>
          <p id="words-help" className="text-base text-muted-foreground">
            Optionally enter one word per line to skip matching links; leave
            empty to allow all words.
          </p>
          <Textarea
            id="blocked-words"
            className="w-full text-base"
            rows={6}
            value={words}
            aria-describedby="words-help words-error"
            aria-invalid={!!wordsError}
            onChange={(event) => {
              const value = event.target.value;
              setWords(value);
              const parsed = settingsUpdateSchema.safeParse({
                blockedWords: value
                  .split(/\n|,/)
                  .map((word) => word.trim())
                  .filter(Boolean),
              });
              setWordsError(
                parsed.success
                  ? null
                  : 'Use at most 100 words of up to 100 characters each.',
              );
              if (parsed.success) save(parsed.data);
            }}
          />
          {wordsError && (
            <p
              id="words-error"
              role="alert"
              className="text-base text-destructive"
            >
              {wordsError}
            </p>
          )}
        </div>
      </div>
      <aside
        role="status"
        aria-live="polite"
        className="sticky top-0 flex w-64 shrink-0 flex-col gap-2 text-base text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <Icon className="size-5" />
          {label}
        </span>
        {failure && <p className="text-destructive">{failure}</p>}
      </aside>
    </div>
  );
};
