import { useEffect, useRef, useState } from 'react';
import { useDebouncer } from '@tanstack/react-pacer';
import { formatConnectionNotesStatus } from '../lib/formatters';
import type { ConnectionNotesStatus } from '../types';
import { Textarea } from '@scholaros/ui/components/textarea';

type ConnectionNotesEditorProps = {
  id: string;
  notes: string | null;
  save: (id: string, notes: string) => Promise<void>;
};

export const ConnectionNotesEditor = ({
  id,
  notes,
  save,
}: ConnectionNotesEditorProps) => {
  const [value, setValue] = useState(notes ?? '');
  const [status, setStatus] = useState<ConnectionNotesStatus>('saved');
  const latest = useRef(value);
  const saved = useRef(value);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = () => {
    const next = latest.current;
    queue.current = queue.current.then(async () => {
      if (next === saved.current) {
        if (mounted.current && latest.current === next) setStatus('saved');
        return;
      }
      try {
        if (mounted.current) setStatus('saving');
        await saveRef.current(id, next);
        saved.current = next;
        if (mounted.current && latest.current === next) setStatus('saved');
      } catch {
        if (mounted.current) setStatus('error');
      }
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const debouncer = useDebouncer(flush, {
    wait: 500,
    // Pacer cancels pending work on unmount by default, but a note typed just
    // before leaving still has to reach the store.
    onUnmount: (instance) => instance.flush(),
  });
  const { label, Icon } = formatConnectionNotesStatus(status);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`notes-${id}`} className="text-muted-foreground">
        Tell the agent anything specific about this site.
      </label>
      <Textarea
        id={`notes-${id}`}
        value={value}
        maxLength={500}
        onChange={(event) => {
          latest.current = event.target.value;
          setValue(event.target.value);
          setStatus('saving');
          debouncer.maybeExecute();
        }}
        className="text-base md:text-base"
        placeholder="e.g. If you see a Google account list, then just select the student account"
        onBlur={() => {
          debouncer.flush();
          // A failed autosave has no pending debounce left to flush.
          if (status === 'error') flush();
        }}
      />
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span>
          {value.length}/500 {label}
        </span>
      </div>
    </div>
  );
};
