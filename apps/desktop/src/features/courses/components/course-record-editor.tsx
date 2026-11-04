import { useId, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@scholaros/ui/components/button';
import { Input } from '@scholaros/ui/components/input';
import { Textarea } from '@scholaros/ui/components/textarea';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { DialogFooter } from '@scholaros/ui/components/dialog';
import { DateTimePicker } from './date-time-picker';
import { academicDateFor, isPastDateInput, legacyDateFrom } from '../lib/dates';
import {
  editCourseSchema,
  editCourseChildSchema,
  type EditCourseSchema,
  type EditCourseChildSchema,
} from '../schemas';
import type {
  CourseChildLocalOverrideField,
  CourseLocalOverrideField,
  CourseSummary,
  SavedCourseChild,
} from '../types';
import type {
  CourseChildLocalOverrideView,
  CourseLocalOverrideView,
} from '../services/store';

const ResetSourceButton = ({
  label,
  isLoading,
  disabled,
  onClick,
}: {
  label: string;
  isLoading: boolean;
  disabled: boolean;
  onClick: () => void;
}) => (
  <TooltipWrapper content={`Reset ${label} to source`}>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Reset ${label} to source`}
      disabled={disabled}
      onClick={onClick}
    >
      <LoadingSwap isLoading={isLoading}>
        <RotateCcw />
      </LoadingSwap>
    </Button>
  </TooltipWrapper>
);

const SourceUncertaintyNotice = () => (
  <p className="text-base text-muted-foreground" role="note">
    Older edits may have replaced source values, so the original values cannot
    be recovered.
  </p>
);

const EditorFooter = ({
  busy,
  creating,
  onCancel,
}: {
  busy: boolean;
  creating: boolean;
  onCancel: () => void;
}) => (
  <DialogFooter>
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
      Cancel
    </Button>
    <Button type="submit" disabled={busy}>
      <LoadingSwap isLoading={busy}>
        {creating ? 'Add' : 'Save changes'}
      </LoadingSwap>
    </Button>
  </DialogFooter>
);

export const CourseRecordEditor = ({
  course,
  local,
  onSave,
  onCancel,
  onReset,
}: {
  course?: CourseSummary & { local?: CourseLocalOverrideView };
  local?: CourseLocalOverrideView;
  onSave: (values: EditCourseSchema) => Promise<void>;
  onCancel: () => void;
  onReset?: (fields: CourseLocalOverrideField[]) => Promise<void>;
}) => {
  const id = useId();
  const [resettingField, setResettingField] = useState<string | null>(null);
  const recordLocal = local ?? course?.local;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditCourseSchema>({
    resolver: zodResolver(editCourseSchema),
    defaultValues: {
      name: course?.name ?? '',
      code: course?.code ?? '',
      term: course?.term ?? '',
      instructor: course?.instructor ?? '',
      description: course?.description ?? '',
    },
  });
  const resetField = async (field: CourseLocalOverrideField) => {
    if (!onReset) return;
    setResettingField(field);
    try {
      await onReset([field]);
    } catch {
      return;
    } finally {
      setResettingField(null);
    }
  };
  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSave)}
      className="flex flex-col gap-4"
    >
      {recordLocal?.sourceUncertain && <SourceUncertaintyNotice />}
      {(
        [
          { name: 'name', label: 'Name' },
          { name: 'code', label: 'Code' },
          { name: 'term', label: 'Term' },
          { name: 'instructor', label: 'Instructor' },
          { name: 'description', label: 'Description' },
        ] as const
      ).map(({ name, label }) => (
        <div key={name} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${id}-${name}`}>{label}</label>
            {recordLocal?.overriddenFields.includes(name) && onReset && (
              <ResetSourceButton
                label={label}
                isLoading={resettingField === name}
                disabled={isSubmitting || !!resettingField}
                onClick={() => void resetField(name)}
              />
            )}
          </div>
          {name === 'description' ? (
            <Textarea
              id={`${id}-${name}`}
              className="w-full text-base"
              {...register(name)}
              aria-invalid={!!errors[name]}
              aria-describedby={
                errors[name] ? `${id}-${name}-error` : undefined
              }
            />
          ) : (
            <Input
              id={`${id}-${name}`}
              className="w-full text-base"
              {...register(name)}
              aria-invalid={!!errors[name]}
              aria-describedby={
                errors[name] ? `${id}-${name}-error` : undefined
              }
            />
          )}
          {errors[name] && (
            <p
              id={`${id}-${name}-error`}
              role="alert"
              className="text-base text-destructive"
            >
              {errors[name].message}
            </p>
          )}
        </div>
      ))}
      <EditorFooter
        busy={isSubmitting}
        creating={!course}
        onCancel={onCancel}
      />
    </form>
  );
};

const childDateForEditor = (
  item: SavedCourseChild & { local?: CourseChildLocalOverrideView },
) => {
  const hasDateOverride = item.local?.overriddenFields.some(
    (field) => field === 'dateValue' || field === 'dateText',
  );
  return hasDateOverride && item.local
    ? legacyDateFrom({
        dateValue: item.local.effective.dateValue,
        dateText: item.local.effective.dateText,
      })
    : academicDateFor(item);
};

export const CourseChildEditor = ({
  item,
  kind,
  local,
  onSave,
  onCancel,
  onReset,
}: {
  item?: SavedCourseChild & { local?: CourseChildLocalOverrideView };
  kind: 'assignments' | 'announcements';
  local?: CourseChildLocalOverrideView;
  onSave: (values: EditCourseChildSchema) => Promise<void>;
  onCancel: () => void;
  onReset?: (fields: CourseChildLocalOverrideField[]) => Promise<void>;
}) => {
  const id = useId();
  const [resettingField, setResettingField] = useState<string | null>(null);
  const recordLocal = local ?? item?.local;
  const initialDate = (item ? childDateForEditor(item) : null)?.original ?? '';
  const resolver = useMemo(
    () =>
      zodResolver(
        editCourseChildSchema.superRefine((values, context) => {
          if (
            kind === 'assignments' &&
            (!item || values.date !== initialDate) &&
            isPastDateInput(values.date)
          )
            context.addIssue({
              code: 'custom',
              path: ['date'],
              message: 'Choose a date and time in the future.',
            });
        }),
      ),
    [initialDate, item, kind],
  );
  const body = item?.local
    ? item.local.effective.body
    : item?.content
      ? 'description' in item.content
        ? item.content.description
        : item.content.body
      : item?.body;
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditCourseChildSchema>({
    resolver,
    defaultValues: {
      title: item?.title ?? '',
      body: body ?? '',
      date: initialDate,
    },
  });
  const resetFields = async (
    fields: readonly CourseChildLocalOverrideField[],
    fieldKey: string,
  ) => {
    if (!onReset) return;
    setResettingField(fieldKey);
    try {
      await onReset([...fields]);
    } catch {
      return;
    } finally {
      setResettingField(null);
    }
  };
  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSave)}
      className="flex flex-col gap-4"
    >
      {recordLocal?.sourceUncertain && <SourceUncertaintyNotice />}
      {(
        [
          { name: 'title', label: 'Title', resetFields: ['title'] },
          {
            name: 'body',
            label: kind === 'assignments' ? 'Description' : 'Message',
            resetFields: ['body'],
          },
          {
            name: 'date',
            label: kind === 'assignments' ? 'Due date' : 'Published date',
            resetFields: ['dateValue', 'dateText'],
          },
        ] as const
      ).map(({ name, label, resetFields: fields }) => {
        const typedFields = fields as readonly CourseChildLocalOverrideField[];
        const overridden = typedFields.some((field) =>
          recordLocal?.overriddenFields.includes(field),
        );
        return (
          <div key={name} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${id}-${name}`}>{label}</label>
              {overridden && onReset && (
                <ResetSourceButton
                  label={label}
                  isLoading={resettingField === name}
                  disabled={isSubmitting || !!resettingField}
                  onClick={() => void resetFields(typedFields, name)}
                />
              )}
            </div>
            {name === 'date' ? (
              <Controller
                control={control}
                name="date"
                render={({ field }) => (
                  <DateTimePicker
                    sourceDate={item ? childDateForEditor(item) : null}
                    allowPast={
                      kind === 'announcements' ||
                      (!!item && field.value === initialDate)
                    }
                    id={`${id}-date`}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            ) : name === 'body' ? (
              <Textarea
                id={`${id}-${name}`}
                className="w-full text-base"
                {...register(name)}
                aria-invalid={!!errors[name]}
                aria-describedby={
                  errors[name] ? `${id}-${name}-error` : undefined
                }
              />
            ) : (
              <Input
                id={`${id}-${name}`}
                className="w-full text-base"
                {...register(name)}
                aria-invalid={!!errors[name]}
                aria-describedby={
                  errors[name] ? `${id}-${name}-error` : undefined
                }
              />
            )}
            {errors[name] && (
              <p
                id={`${id}-${name}-error`}
                role="alert"
                className="text-base text-destructive"
              >
                {errors[name].message}
              </p>
            )}
          </div>
        );
      })}
      <EditorFooter busy={isSubmitting} creating={!item} onCancel={onCancel} />
    </form>
  );
};
