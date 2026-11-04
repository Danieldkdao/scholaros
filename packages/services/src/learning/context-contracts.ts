import { z } from 'zod';
import { idSchema, instantSchema, revisionSchema } from './product-contracts';

export const contextKinds = [
  'note',
  'preference',
  'document',
  'image',
  'explanation',
  'activity',
] as const;
export type ContextKind = (typeof contextKinds)[number];
export const contextProvenances = [
  'user-authored',
  'user-uploaded',
  'connected-source',
  'ai-generated',
] as const;
export type ContextProvenance = (typeof contextProvenances)[number];
export const ingestionStatuses = [
  'queued',
  'processing',
  'complete',
  'partial',
  'unreadable',
  'unsupported',
  'failed',
  'cancelled',
] as const;
export type IngestionStatus = (typeof ingestionStatuses)[number];
export const sourceKinds = [
  'course-material',
  'context-version',
  'assignment',
  'announcement',
  'saved-activity',
  'grade-evidence',
] as const;
export type SourceKind = (typeof sourceKinds)[number];
export const sourceStates = [
  'current',
  'historical',
  'removed',
  'unavailable',
] as const;
export type SourceState = (typeof sourceStates)[number];

export const locatorKinds = ['page', 'heading', 'paragraph'] as const;
export type LocatorKind = (typeof locatorKinds)[number];
export const contextImageMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type ContextImageMimeType = (typeof contextImageMimeTypes)[number];
export const contextPreviewUnavailableReasons = [
  'removed',
  'unreadable',
  'unsupported',
  'offline',
  'processing',
] as const;
export type ContextPreviewUnavailableReason =
  (typeof contextPreviewUnavailableReasons)[number];
export const locatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    page: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('heading'), heading: z.string().max(300) }),
  z.strictObject({
    kind: z.literal('paragraph'),
    ordinal: z.number().int().positive(),
  }),
]);
export type LocatorSchema = z.infer<typeof locatorSchema>;
export type Locator = z.infer<typeof locatorSchema>;

export const sourceReferenceSchema = z.strictObject({
  sourceKind: z.enum(sourceKinds),
  sourceId: idSchema,
  versionId: idSchema.nullable(),
  courseId: idSchema.nullable(),
  locator: locatorSchema.nullable(),
  title: z.string().max(300),
  provenance: z.enum(contextProvenances),
  observedAt: instantSchema.nullable(),
  state: z.enum(sourceStates),
});
export type SourceReferenceSchema = z.infer<typeof sourceReferenceSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const contextItemSchema = z.strictObject({
  id: idSchema,
  title: z.string().max(160),
  kind: z.enum(contextKinds),
  provenance: z.enum(contextProvenances),
  courseIds: z.array(idSchema).max(1),
  currentVersionId: idSchema.nullable(),
  status: z.enum(ingestionStatuses),
  usable: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  revision: revisionSchema,
  source: z
    .strictObject({
      sessionId: idSchema.nullable(),
      sourceId: idSchema.nullable(),
      sourceVersion: z.string().max(300).nullable(),
      removed: z.boolean(),
    })
    .nullable(),
});
export type ContextItemSchema = z.infer<typeof contextItemSchema>;
export type ContextItemDTO = z.infer<typeof contextItemSchema>;

export const contextVersionSchema = z.strictObject({
  id: idSchema,
  itemId: idSchema,
  contentHash: z.string().max(128),
  mimeType: z.string().max(100),
  byteLength: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  extractionStatus: z.enum(ingestionStatuses),
  interpretedPages: z.array(z.number().int().positive()).max(200),
  uncertainty: z.string().max(1000).nullable(),
  createdAt: instantSchema,
  originalAvailable: z.boolean(),
  locators: z.array(locatorSchema).max(2000),
});
export type ContextVersionSchema = z.infer<typeof contextVersionSchema>;
export type ContextVersionDTO = z.infer<typeof contextVersionSchema>;

export const contextPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().max(50_000),
    locators: z.array(locatorSchema).max(200),
    partial: z.boolean(),
    uncertainty: z.string().max(1000).nullable(),
  }),
  z.strictObject({
    kind: z.literal('image'),
    mimeType: z.enum(contextImageMimeTypes),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength <= 1_048_576),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum(contextPreviewUnavailableReasons),
  }),
]);
export type ContextPreviewSchema = z.infer<typeof contextPreviewSchema>;
export type ContextPreview = z.infer<typeof contextPreviewSchema>;

export const sourcePassageSchema = z.strictObject({
  reference: sourceReferenceSchema,
  text: z.string().max(2000),
  score: z.number().finite().nullable(),
});
export type SourcePassageSchema = z.infer<typeof sourcePassageSchema>;
export type SourcePassage = z.infer<typeof sourcePassageSchema>;

export const documentPageStatuses = [
  'readable',
  'partial',
  'uncertain',
  'unreadable',
] as const;
export type DocumentPageStatus = (typeof documentPageStatuses)[number];
export const documentInterpretationStatuses = [
  'complete',
  'partial',
  'unreadable',
] as const;
export type DocumentInterpretationStatus =
  (typeof documentInterpretationStatuses)[number];
