import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@scholaros/ui/components/button';
import { Input } from '@scholaros/ui/components/input';
import { Textarea } from '@scholaros/ui/components/textarea';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { DialogFooter } from '@scholaros/ui/components/dialog';
import { DateTimePicker } from './date-time-picker';
import { academicDateFor } from '../lib/dates';
import {
  editCourseSchema,
  editCourseChildSchema,
  type EditCourseSchema,
  type EditCourseChildSchema,
} from '../schemas';
import type { CourseSummary, SavedCourseChild } from '../types';

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
  onSave,
  onCancel,
}: {
  course?: CourseSummary;
  onSave: (values: EditCourseSchema) => Promise<void>;
  onCancel: () => void;
}) => {
  const id = useId();
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
  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSave)}
      className="flex flex-col gap-4"
    >
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
          <label htmlFor={`${id}-${name}`}>{label}</label>
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

export const CourseChildEditor = ({
  item,
  kind,
  onSave,
  onCancel,
}: {
  item?: SavedCourseChild;
  kind: 'assignments' | 'announcements';
  onSave: (values: EditCourseChildSchema) => Promise<void>;
  onCancel: () => void;
}) => {
  const id = useId();
  const body = item?.content
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
    resolver: zodResolver(editCourseChildSchema),
    defaultValues: {
      title: item?.title ?? '',
      body: body ?? '',
      date: (item ? academicDateFor(item) : null)?.original ?? '',
    },
  });
  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSave)}
      className="flex flex-col gap-4"
    >
      {(
        [
          { name: 'title', label: 'Title' },
          {
            name: 'body',
            label: kind === 'assignments' ? 'Description' : 'Message',
          },
          {
            name: 'date',
            label: kind === 'assignments' ? 'Due date' : 'Published date',
          },
        ] as const
      ).map(({ name, label }) => (
        <div key={name} className="flex flex-col gap-2">
          <label htmlFor={`${id}-${name}`}>{label}</label>
          {name === 'date' ? (
            <Controller
              control={control}
              name="date"
              render={({ field }) => (
                <DateTimePicker
                  sourceDate={item ? academicDateFor(item) : null}
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
      ))}
      <EditorFooter busy={isSubmitting} creating={!item} onCancel={onCancel} />
    </form>
  );
};
