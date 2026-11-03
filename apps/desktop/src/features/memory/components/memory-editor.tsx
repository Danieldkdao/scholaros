import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  preferenceFields,
  type MemoryDTO,
  type PreferenceContent,
  type PreferenceField,
} from '@scholaros/services/learning/memory-contracts';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@scholaros/ui/components/field';
import { Input } from '@scholaros/ui/components/input';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { errorMessage } from '../../../lib/error-message';
import { formatPreferenceField } from '../lib/formatters';

type EditableMemory = MemoryDTO & {
  type: 'explicit-preference' | 'provisional-preference';
  content: PreferenceContent;
};
type MemoryEditorProps = {
  memory: MemoryDTO;
  onCancel: () => void;
  onSave: (input: {
    memoryId: string;
    expectedRevision: number;
    preference: PreferenceContent;
  }) => Promise<void>;
};

const isEditableMemory = (memory: MemoryDTO): memory is EditableMemory =>
  memory.type !== 'learning-observation' && 'field' in memory.content;

export const MemoryEditor = ({
  memory,
  onCancel,
  onSave,
}: MemoryEditorProps) => {
  const preference = isEditableMemory(memory) ? memory.content : null;
  const [field, setField] = useState<PreferenceField>(
    preference?.field ?? 'explanation-length',
  );
  const [value, setValue] = useState(preference?.value ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const fieldDescriptionId = useId();
  const fieldErrorId = useId();
  const valueInputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => {
    if (!preference) return;
    setField(preference.field);
    setValue(preference.value);
    setFieldError(null);
    setSaveError(null);
  }, [memory.id, memory.revision, preference?.field, preference?.value]);

  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  if (!preference) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setFieldError('Add a preference before saving.');
      return;
    }
    setFieldError(null);
    setSaveError(null);
    setSaving(true);
    const attempt = ++request.current;
    try {
      await onSave({
        memoryId: memory.id,
        expectedRevision: memory.revision,
        preference: { field, value: normalizedValue },
      });
      if (attempt === request.current) onCancel();
    } catch (cause) {
      if (attempt === request.current)
        setSaveError(errorMessage(cause, 'Could not update this memory.'));
    } finally {
      if (attempt === request.current) setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
    >
      <DialogContent
        initialFocus={valueInputRef}
        finalFocus
        className="motion-reduce:animate-none"
      >
        <DialogHeader>
          <DialogTitle>
            {memory.type === 'provisional-preference'
              ? 'Correct this suggestion'
              : 'Edit remembered preference'}
          </DialogTitle>
          <DialogDescription>
            An explicit correction takes priority over older inferred
            preferences.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Edit remembered preference"
          aria-busy={saving}
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <Field>
            <FieldLabel id="memory-editor-field-label" htmlFor={fieldId}>
              Preference type
            </FieldLabel>
            <Select
              value={field}
              disabled={saving}
              onValueChange={(nextValue) => {
                if (typeof nextValue !== 'string') return;
                const selectedField = preferenceFields.find(
                  (preferenceField) => preferenceField === nextValue,
                );
                if (selectedField) setField(selectedField);
              }}
            >
              <SelectTrigger
                id={fieldId}
                disabled={saving}
                aria-label="Preference type"
                aria-labelledby="memory-editor-field-label"
                className="w-full"
              >
                <SelectValue placeholder="Choose a preference type" />
              </SelectTrigger>
              <SelectContent>
                {preferenceFields.map((preferenceField) => (
                  <SelectItem key={preferenceField} value={preferenceField}>
                    {formatPreferenceField(preferenceField).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-value`}>
              Remembered preference
            </FieldLabel>
            <Input
              ref={valueInputRef}
              id={`${fieldId}-value`}
              aria-label="Preference value"
              aria-describedby={
                fieldError
                  ? `${fieldDescriptionId} ${fieldErrorId}`
                  : fieldDescriptionId
              }
              aria-invalid={fieldError !== null}
              autoComplete="off"
              disabled={saving}
              maxLength={300}
              value={value}
              onChange={(event) => {
                setValue(event.currentTarget.value);
                if (fieldError) setFieldError(null);
              }}
            />
            <FieldDescription id={fieldDescriptionId}>
              This preference is used in future study sessions.
            </FieldDescription>
            {fieldError && (
              <FieldError id={fieldErrorId}>{fieldError}</FieldError>
            )}
          </Field>
          {saveError && (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              aria-busy={saving}
              aria-label={saving ? 'Saving correction' : 'Save correction'}
            >
              <LoadingSwap isLoading={saving}>Save correction</LoadingSwap>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
