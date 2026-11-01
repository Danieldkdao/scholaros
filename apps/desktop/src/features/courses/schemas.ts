import { z } from 'zod';
import { isPastDateInput } from './lib/dates';
import { resourceKinds } from '@scholaros/services/ai/resources/shared';

export const courseRecordSchema = z.object({
  kind: z.enum(resourceKinds),
  courseId: z.string().min(1).max(300),
  id: z.string().min(1).max(300),
});
export type CourseRecordSchema = z.infer<typeof courseRecordSchema>;
export const editCourseSchema = z.object({
  name: z.string().trim().min(1, 'Enter a course name.').max(300),
  code: z.string().trim().max(100),
  term: z.string().trim().max(200),
  instructor: z.string().trim().max(500),
  description: z.string().trim().max(10000),
});
export type EditCourseSchema = z.infer<typeof editCourseSchema>;
export const editCourseChildSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(300),
  body: z.string().trim().max(20000),
  date: z
    .string()
    .trim()
    .max(200)
    .refine(
      (value) => !isPastDateInput(value),
      'Choose a date and time in the future.',
    ),
});
export type EditCourseChildSchema = z.infer<typeof editCourseChildSchema>;
export const updateCourseRecordSchema = z.discriminatedUnion('kind', [
  courseRecordSchema.extend({
    kind: z.literal('courses'),
    values: editCourseSchema,
  }),
  courseRecordSchema.extend({
    kind: z.literal('assignments'),
    values: editCourseChildSchema,
  }),
  courseRecordSchema.extend({
    kind: z.literal('announcements'),
    values: editCourseChildSchema,
  }),
]);
export type UpdateCourseRecordSchema = z.infer<typeof updateCourseRecordSchema>;

export const createCourseRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('courses'), values: editCourseSchema }),
  z.object({
    kind: z.literal('assignments'),
    courseId: courseRecordSchema.shape.courseId,
    values: editCourseChildSchema,
  }),
  z.object({
    kind: z.literal('announcements'),
    courseId: courseRecordSchema.shape.courseId,
    values: editCourseChildSchema,
  }),
]);
export type CreateCourseRecordSchema = z.infer<typeof createCourseRecordSchema>;
