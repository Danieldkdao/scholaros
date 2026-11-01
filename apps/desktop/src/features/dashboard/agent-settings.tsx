import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react';
import { Input } from '@scholaros/ui/components/input';
import { Textarea } from '@scholaros/ui/components/textarea';
import { settingsUpdateSchema } from '../onboarding/schemas';
import type { SettingsUpdateSchema } from '../onboarding/schemas';
import {
  getSettingsSaveState,
  queueSettingsSave,
  reconcileSettingsSaveDraft,
  subscribeSettingsSaveState,
} from './settings-save-queue';

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
  accountId,
  decisionTimeSeconds,
  blockedWords,
  onSave,
}: {
  accountId: string;
  decisionTimeSeconds: number;
  blockedWords: string[];
  onSave: (changes: SettingsUpdateSchema) => Promise<void>;
}) => {
  const [seconds, setSeconds] = useState(() =>
    String(
      getSettingsSaveState(accountId).draft.decisionTimeSeconds ??
        decisionTimeSeconds,
    ),
  );
  const [words, setWords] = useState(
    () =>
      getSettingsSaveState(accountId).draft.blockedWords?.join('\n') ??
      blockedWords.join('\n'),
  );
  const [wordsError, setWordsError] = useState<string | null>(null);
  const previousAccountId = useRef(accountId);
  const subscribe = useCallback(
    (listener: () => void) => subscribeSettingsSaveState(accountId, listener),
    [accountId],
  );
  const getSnapshot = useCallback(
    () => getSettingsSaveState(accountId),
    [accountId],
  );
  const sharedSaveState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  useEffect(() => {
    reconcileSettingsSaveDraft(accountId, {
      decisionTimeSeconds,
      blockedWords,
    });
  }, [
    accountId,
    blockedWords,
    decisionTimeSeconds,
    sharedSaveState.draft,
    sharedSaveState.error,
    sharedSaveState.pending,
  ]);
  useEffect(() => {
    if (previousAccountId.current === accountId) return;
    previousAccountId.current = accountId;
    const draft = getSettingsSaveState(accountId).draft;
    setSeconds(String(draft.decisionTimeSeconds ?? decisionTimeSeconds));
    setWords(draft.blockedWords?.join('\n') ?? blockedWords.join('\n'));
    setWordsError(null);
  }, [accountId, blockedWords, decisionTimeSeconds]);
  const validTime = settingsUpdateSchema.safeParse({
    decisionTimeSeconds: Number(seconds),
  }).success;
  const save = (changes: SettingsUpdateSchema) => {
    void queueSettingsSave(accountId, changes, () => onSave(changes)).catch(
      () => undefined,
    );
  };
  const visibleStatus: SaveStatus =
    sharedSaveState.pending > 0
      ? 'saving'
      : sharedSaveState.error
        ? 'error'
        : 'saved';
  const visibleFailure = sharedSaveState.error;
  const { label, Icon } = formatSaveStatus(visibleStatus);
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
        {visibleFailure && <p className="text-destructive">{visibleFailure}</p>}
      </aside>
    </div>
  );
};
