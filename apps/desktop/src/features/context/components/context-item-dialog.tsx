import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ContextItemDTO } from '@scholaros/services/learning/context-contracts';
import { preferenceFields } from '@scholaros/services/learning/memory-contracts';
import type {
  PreferenceContent,
  PreferenceField,
} from '@scholaros/services/learning/memory-contracts';
import { Button } from '@scholaros/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import { Input } from '@scholaros/ui/components/input';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { Textarea } from '@scholaros/ui/components/textarea';
import { errorMessage } from '../../../lib/error-message';
import type { ContextCourse } from '../hooks/use-context-library';

type NoteDialogProps = {
  mode: 'note';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: RefObject<HTMLElement | null>;
  courses: ContextCourse[];
  readOnly?: boolean;
  item?: ContextItemDTO;
  initialText?: string;
  canEditText: boolean;
  onSave: (input: {
    title: string;
    text?: string;
    courseId: string | null;
  }) => Promise<void>;
};

type PreferenceDialogProps = {
  mode: 'preference';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: RefObject<HTMLElement | null>;
  courses: ContextCourse[];
  readOnly?: boolean;
  onSave: (input: {
    preference: PreferenceContent;
    courseId: string | null;
  }) => Promise<void>;
};

type ContextItemDialogProps = NoteDialogProps | PreferenceDialogProps;

const formatPreferenceField = (field: PreferenceField) => {
  switch (field) {
    case 'explanation-length':
      return 'Explanation length';
    case 'vocabulary':
      return 'Vocabulary';
    case 'example-style':
      return 'Example style';
    case 'learning-level':
      return 'Learning level';
  }
};

const CourseSelect = ({
  courses,
  value,
  onChange,
  label,
  disabled = false,
}: {
  courses: ContextCourse[];
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
  disabled?: boolean;
}) => (
  <div className="flex flex-col gap-2">
    <span>{label}</span>
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) =>
        onChange(typeof nextValue === 'string' ? nextValue : null)
      }
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue>
          {courses.find((course) => course.id === value)?.name ?? 'No course'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={null}>No course</SelectItem>
        {courses.map((course) => (
          <SelectItem key={course.id} value={course.id}>
            {course.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

const focusAfterMenuClose = (input: RefObject<HTMLInputElement | null>) => {
  // Dropdown focus restoration runs after its selection handler.
  const timeout = window.setTimeout(() => input.current?.focus(), 0);
  return () => window.clearTimeout(timeout);
};

const NoteDialog = (props: NoteDialogProps) => {
  const id = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setTitle(props.item?.title ?? '');
    setText(props.initialText ?? '');
    setCourseId(props.item?.courseIds[0] ?? null);
    setTitleError(null);
    setTextError(null);
    setRequestError(null);
    return focusAfterMenuClose(titleInput);
  }, [
    props.open,
    props.item?.id,
    props.item?.title,
    props.item?.courseIds,
    props.initialText,
  ]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.readOnly) return;
    const nextTitleError = title.trim() ? null : 'Enter a title.';
    const nextTextError =
      props.canEditText && !text.trim() ? 'Enter some note text.' : null;
    setTitleError(nextTitleError);
    setTextError(nextTextError);
    setRequestError(null);
    if (nextTitleError || nextTextError) return;
    setSaving(true);
    try {
      await props.onSave({
        title: title.trim(),
        ...(props.canEditText ? { text: text.trim() } : {}),
        courseId,
      });
    } catch (cause) {
      setRequestError(errorMessage(cause, 'Could not save this note.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!saving) props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        initialFocus={titleInput}
        finalFocus={props.finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{props.item ? 'Edit note' : 'Add a note'}</DialogTitle>
          <DialogDescription>
            Keep useful class context here; it never changes source or access
            permissions.
          </DialogDescription>
          {props.readOnly && (
            <p role="status" className="text-base text-muted-foreground">
              Reconnect online to save Context changes.
            </p>
          )}
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-title`}>Title</label>
            <Input
              ref={titleInput}
              id={`${id}-title`}
              name="title"
              className="w-full text-base"
              maxLength={160}
              required
              readOnly={props.readOnly}
              value={title}
              aria-invalid={!!titleError}
              aria-describedby={titleError ? `${id}-title-error` : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
            {titleError && (
              <p
                id={`${id}-title-error`}
                role="alert"
                className="text-base text-destructive"
              >
                {titleError}
              </p>
            )}
          </div>
          {props.canEditText ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${id}-text`}>Note</label>
              <Textarea
                id={`${id}-text`}
                name="text"
                className="min-h-48 w-full text-base"
                maxLength={50_000}
                required
                readOnly={props.readOnly}
                value={text}
                aria-invalid={!!textError}
                aria-describedby={textError ? `${id}-text-error` : undefined}
                onChange={(event) => setText(event.target.value)}
              />
              {textError && (
                <p
                  id={`${id}-text-error`}
                  role="alert"
                  className="text-base text-destructive"
                >
                  {textError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-base text-muted-foreground">
              The full note text is unavailable, so this edit will not replace
              it.
            </p>
          )}
          <CourseSelect
            courses={props.courses}
            value={courseId}
            onChange={setCourseId}
            label="Course"
            disabled={props.readOnly}
          />
          {requestError && (
            <p role="alert" className="text-base text-destructive">
              {requestError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || props.readOnly}>
              <LoadingSwap isLoading={saving}>
                {props.item ? 'Save changes' : 'Add note'}
              </LoadingSwap>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const PreferenceDialog = (props: PreferenceDialogProps) => {
  const id = useId();
  const preferenceInput = useRef<HTMLInputElement>(null);
  const [field, setField] = useState<PreferenceField>('explanation-length');
  const [value, setValue] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setField('explanation-length');
    setValue('');
    setCourseId(null);
    setValueError(null);
    setRequestError(null);
    return focusAfterMenuClose(preferenceInput);
  }, [props.open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.readOnly) return;
    const nextValueError = value.trim() ? null : 'Enter a preference.';
    setValueError(nextValueError);
    setRequestError(null);
    if (nextValueError) return;
    setSaving(true);
    try {
      await props.onSave({
        preference: { field, value: value.trim() },
        courseId,
      });
    } catch (cause) {
      setRequestError(errorMessage(cause, 'Could not save this preference.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!saving) props.onOpenChange(open);
      }}
    >
      <DialogContent
        initialFocus={preferenceInput}
        finalFocus={props.finalFocus}
      >
        <DialogHeader>
          <DialogTitle>Add a personal preference</DialogTitle>
          <DialogDescription>
            Preferences personalize explanations but never change access or
            coursework rules.
          </DialogDescription>
          {props.readOnly && (
            <p role="status" className="text-base text-muted-foreground">
              Reconnect online to save Context changes.
            </p>
          )}
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <span id={`${id}-field-label`}>Preference type</span>
            <Select
              value={field}
              onValueChange={(nextValue) => {
                if (typeof nextValue === 'string')
                  setField(nextValue as PreferenceField);
              }}
            >
              <SelectTrigger
                aria-labelledby={`${id}-field-label`}
                className="w-full"
              >
                <SelectValue>{formatPreferenceField(field)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {preferenceFields.map((option) => (
                  <SelectItem key={option} value={option}>
                    {formatPreferenceField(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-value`}>Preference</label>
            <Input
              ref={preferenceInput}
              id={`${id}-value`}
              name="value"
              className="w-full text-base"
              maxLength={300}
              required
              readOnly={props.readOnly}
              value={value}
              aria-invalid={!!valueError}
              aria-describedby={valueError ? `${id}-value-error` : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            {valueError && (
              <p
                id={`${id}-value-error`}
                role="alert"
                className="text-base text-destructive"
              >
                {valueError}
              </p>
            )}
          </div>
          <CourseSelect
            courses={props.courses}
            value={courseId}
            onChange={setCourseId}
            label="Course scope"
            disabled={props.readOnly}
          />
          {requestError && (
            <p role="alert" className="text-base text-destructive">
              {requestError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || props.readOnly}>
              <LoadingSwap isLoading={saving}>Add preference</LoadingSwap>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const ContextItemDialog = (props: ContextItemDialogProps) =>
  props.mode === 'note' ? (
    <NoteDialog {...props} />
  ) : (
    <PreferenceDialog {...props} />
  );
