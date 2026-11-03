import { z } from 'zod';
import {
  courseChildLocalOverrideFields,
  courseCollectionInterruptionCategories,
  courseCollectionKinds,
  courseLocalOverrideFields,
  courseRecordKinds,
  courseScanStatuses,
} from './types';

export const courseRecordSchema = z.object({
  kind: z.enum(courseRecordKinds),
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
  date: z.string().trim().max(200),
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

export const courseCollectionInterruptionSchema = z.strictObject({
  category: z.enum(courseCollectionInterruptionCategories),
  retryAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type CourseCollectionInterruptionSchema = z.infer<
  typeof courseCollectionInterruptionSchema
>;

export const hostCourseCollectionCoverageEvidenceSchema = z.strictObject({
  ownerId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200).nullable(),
  collectionKind: z.enum(courseCollectionKinds),
  collectionUrls: z.array(z.string().url().max(2048)).max(30),
  observedAt: z.iso.datetime({ offset: true }),
  usableItemCount: z.number().int().min(0).max(10_000),
  pagination: z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('not-applicable'),
      visitedPageUrls: z.array(z.string().url().max(2048)).max(100),
    }),
    z.strictObject({
      state: z.literal('exhausted'),
      visitedPageUrls: z.array(z.string().url().max(2048)).min(1).max(100),
    }),
    z.strictObject({
      state: z.literal('pending'),
      visitedPageUrls: z.array(z.string().url().max(2048)).min(1).max(100),
      nextPageUrl: z.string().url().max(2048),
    }),
  ]),
  explicitEmptyEvidence: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('observed-empty-list'),
        pageUrl: z.string().url().max(2048),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      z.strictObject({
        kind: z.literal('observed-zero-count'),
        pageUrl: z.string().url().max(2048),
        count: z.literal(0),
        observedAt: z.iso.datetime({ offset: true }),
      }),
    ])
    .nullable(),
  gaps: z.strictObject({
    pendingPagination: z.boolean(),
    unreadable: z.boolean(),
    blockedRequiredData: z.boolean(),
    truncated: z.boolean(),
    invalidRecords: z.boolean(),
    ambiguousIdentity: z.boolean(),
    scopeUnverified: z.boolean(),
  }),
});
export type HostCourseCollectionCoverageEvidenceSchema = z.infer<
  typeof hostCourseCollectionCoverageEvidenceSchema
>;

export const courseCollectionScanSchema = z
  .strictObject({
    status: z.enum(courseScanStatuses),
    interruption: courseCollectionInterruptionSchema.nullable(),
    hostCoverage: hostCourseCollectionCoverageEvidenceSchema,
    items: z.array(z.unknown()).max(10_000),
    inactiveItems: z.array(z.unknown()).max(10_000).optional(),
  })
  .superRefine(
    ({ status, interruption, hostCoverage, items, inactiveItems }, context) => {
      const {
        collectionKind,
        courseId,
        explicitEmptyEvidence,
        gaps,
        usableItemCount,
      } = hostCoverage;
      if (usableItemCount !== items.length + (inactiveItems?.length ?? 0))
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'usableItemCount'],
          message: 'Coverage count must match returned usable findings.',
        });
      if (collectionKind === 'courses' && courseId !== null)
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'courseId'],
          message: 'Course-list evidence cannot have a course scope.',
        });
      if (collectionKind !== 'courses' && courseId === null)
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'courseId'],
          message: 'Resource collection evidence requires a course scope.',
        });
      for (const [index, url] of hostCoverage.collectionUrls.entries())
        if (!hostCoverage.pagination.visitedPageUrls.includes(url))
          context.addIssue({
            code: 'custom',
            path: ['hostCoverage', 'collectionUrls', index],
            message: 'Collection URLs must reference visited pages.',
          });
      if (
        (hostCoverage.pagination.state === 'pending') !==
        gaps.pendingPagination
      )
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'gaps', 'pendingPagination'],
          message: 'Pagination state and pending coverage gap must agree.',
        });
      if (
        usableItemCount === 0 &&
        status === 'complete' &&
        !explicitEmptyEvidence
      )
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'explicitEmptyEvidence'],
          message:
            'Complete empty collections require observed empty evidence.',
        });
      if (usableItemCount > 0 && explicitEmptyEvidence)
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'explicitEmptyEvidence'],
          message: 'Empty evidence cannot accompany observed records.',
        });
      if (
        explicitEmptyEvidence &&
        (!hostCoverage.pagination.visitedPageUrls.includes(
          explicitEmptyEvidence.pageUrl,
        ) ||
          !hostCoverage.collectionUrls.includes(explicitEmptyEvidence.pageUrl))
      )
        context.addIssue({
          code: 'custom',
          path: ['hostCoverage', 'explicitEmptyEvidence', 'pageUrl'],
          message: 'Empty evidence must reference a visited page.',
        });
      if (status === 'complete') {
        if (interruption)
          context.addIssue({
            code: 'custom',
            path: ['interruption'],
            message: 'Complete coverage cannot include an interruption.',
          });
        if (
          !hostCoverage.collectionUrls.length ||
          hostCoverage.pagination.state === 'pending' ||
          Object.values(gaps).some(Boolean)
        )
          context.addIssue({
            code: 'custom',
            path: ['hostCoverage'],
            message:
              'Complete coverage requires an observed gap-free collection.',
          });
      }
    },
  );
export type CourseCollectionScanSchema = z.infer<
  typeof courseCollectionScanSchema
>;

export const courseLocalOverrideFieldsSchema = z.enum(
  courseLocalOverrideFields,
);
export type CourseLocalOverrideFieldsSchema = z.infer<
  typeof courseLocalOverrideFieldsSchema
>;

export const courseRecordFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(300),
  code: z.string().max(100).nullable(),
  term: z.string().max(200).nullable(),
  instructor: z.string().max(500).nullable(),
  description: z.string().max(10_000).nullable(),
});
export type CourseRecordFieldsSchema = z.infer<typeof courseRecordFieldsSchema>;

export const courseLocalOverridesSchema = z.strictObject({
  name: z.string().trim().min(1).max(300).optional(),
  code: z.string().max(100).nullable().optional(),
  term: z.string().max(200).nullable().optional(),
  instructor: z.string().max(500).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
});
export type CourseLocalOverridesSchema = z.infer<
  typeof courseLocalOverridesSchema
>;

export const courseChildLocalOverrideFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(20_000).nullable().optional(),
  dateValue: z.string().max(200).nullable().optional(),
  dateText: z.string().max(200).nullable().optional(),
});
export type CourseChildLocalOverrideFieldsSchema = z.infer<
  typeof courseChildLocalOverrideFieldsSchema
>;

export const courseLocalOverrideDtoSchema = z
  .strictObject({
    source: courseRecordFieldsSchema,
    effective: courseRecordFieldsSchema,
    overrides: courseLocalOverridesSchema,
    overriddenFields: z
      .array(courseLocalOverrideFieldsSchema)
      .max(courseLocalOverrideFields.length),
    localEditedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine(
    ({ source, effective, overrides, overriddenFields }, context) => {
      const overrideKeys = Object.entries(overrides)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);
      if (
        overrideKeys.length !== overriddenFields.length ||
        overriddenFields.some((field) => !overrideKeys.includes(field))
      )
        context.addIssue({
          code: 'custom',
          path: ['overriddenFields'],
          message: 'Override fields must match the saved override values.',
        });
      for (const field of courseLocalOverrideFields) {
        const expectedValue =
          overrides[field] === undefined ? source[field] : overrides[field];
        if (effective[field] !== expectedValue)
          context.addIssue({
            code: 'custom',
            path: ['effective', field],
            message:
              'Effective fields must apply local overrides to source data.',
          });
      }
    },
  );
export type CourseLocalOverrideDtoSchema = z.infer<
  typeof courseLocalOverrideDtoSchema
>;

export const courseChildLocalOverrideDtoSchema = z
  .strictObject({
    source: z.strictObject({
      title: z.string().trim().min(1).max(300),
      body: z.string().max(20_000).nullable(),
      dateValue: z.string().max(200).nullable(),
      dateText: z.string().max(200).nullable(),
    }),
    effective: z.strictObject({
      title: z.string().trim().min(1).max(300),
      body: z.string().max(20_000).nullable(),
      dateValue: z.string().max(200).nullable(),
      dateText: z.string().max(200).nullable(),
    }),
    overrides: courseChildLocalOverrideFieldsSchema,
    overriddenFields: z
      .array(z.enum(courseChildLocalOverrideFields))
      .max(courseChildLocalOverrideFields.length),
    localEditedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine(
    ({ source, effective, overrides, overriddenFields }, context) => {
      const overrideKeys = Object.entries(overrides)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);
      if (
        overrideKeys.length !== overriddenFields.length ||
        overriddenFields.some((field) => !overrideKeys.includes(field))
      )
        context.addIssue({
          code: 'custom',
          path: ['overriddenFields'],
          message: 'Override fields must match the saved override values.',
        });
      for (const field of courseChildLocalOverrideFields) {
        const expectedValue =
          overrides[field] === undefined ? source[field] : overrides[field];
        if (effective[field] !== expectedValue)
          context.addIssue({
            code: 'custom',
            path: ['effective', field],
            message:
              'Effective fields must apply local overrides to source data.',
          });
      }
    },
  );
export type CourseChildLocalOverrideDtoSchema = z.infer<
  typeof courseChildLocalOverrideDtoSchema
>;

export const courseRecordSuppressionSchema = z.strictObject({
  suppressionId: z.string().trim().min(1).max(200),
  kind: z.enum(courseRecordKinds),
  title: z.string().trim().min(1).max(300),
  context: z.string().trim().max(500).nullable(),
  hiddenAt: z.iso.datetime({ offset: true }),
  legacy: z.boolean(),
});
export type CourseRecordSuppressionSchema = z.infer<
  typeof courseRecordSuppressionSchema
>;

export const listCourseRecordSuppressionsSchema = z.strictObject({
  connectionId: z.string().trim().min(1).max(200).optional(),
  courseId: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(courseRecordKinds).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListCourseRecordSuppressionsSchema = z.infer<
  typeof listCourseRecordSuppressionsSchema
>;

export const restoreCourseRecordSuppressionSchema = z.discriminatedUnion(
  'scope',
  [
    z.strictObject({
      scope: z.literal('group'),
      suppressionId: z.string().trim().min(1).max(200),
    }),
    z.strictObject({
      scope: z.literal('legacy'),
      connectionId: z.string().trim().min(1).max(200),
      courseId: z.string().trim().min(1).max(200),
      kind: z.enum(courseRecordKinds),
    }),
  ],
);
export type RestoreCourseRecordSuppressionSchema = z.infer<
  typeof restoreCourseRecordSuppressionSchema
>;
