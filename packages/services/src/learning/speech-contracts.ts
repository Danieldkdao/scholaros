import { z } from 'zod';
import {
  idSchema,
  requestIdSchema,
  revisionSchema,
  safeErrorCodeSchema,
} from './product-contracts';

export const dictationEventKinds = [
  'ready',
  'partial',
  'final',
  'error',
  'ended',
] as const;
export type DictationEventKind = (typeof dictationEventKinds)[number];
export const dictationEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    operationId: idSchema,
    sessionId: idSchema,
    composerRevision: revisionSchema,
    sequence: revisionSchema,
    kind: z.literal('ready'),
  }),
  z.strictObject({
    version: z.literal(1),
    operationId: idSchema,
    sessionId: idSchema,
    composerRevision: revisionSchema,
    sequence: revisionSchema,
    kind: z.literal('partial'),
    text: z.string().max(8000),
  }),
  z.strictObject({
    version: z.literal(1),
    operationId: idSchema,
    sessionId: idSchema,
    composerRevision: revisionSchema,
    sequence: revisionSchema,
    kind: z.literal('final'),
    text: z.string().max(8000),
  }),
  z.strictObject({
    version: z.literal(1),
    operationId: idSchema,
    sessionId: idSchema,
    composerRevision: revisionSchema,
    sequence: revisionSchema,
    kind: z.literal('error'),
    errorCode: safeErrorCodeSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    operationId: idSchema,
    sessionId: idSchema,
    composerRevision: revisionSchema,
    sequence: revisionSchema,
    kind: z.literal('ended'),
  }),
]);
export type DictationEventSchema = z.infer<typeof dictationEventSchema>;
export type DictationEvent = z.infer<typeof dictationEventSchema>;
export const dictationStartInputSchema = z.strictObject({
  sessionId: idSchema,
  requestId: requestIdSchema,
  composerRevision: revisionSchema,
});
export type DictationStartInputSchema = z.infer<
  typeof dictationStartInputSchema
>;
export type DictationStartInput = z.infer<typeof dictationStartInputSchema>;
export const dictationAudioChunkSchema = z.strictObject({
  operationId: idSchema,
  sequence: revisionSchema,
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 16_384),
});
export type DictationAudioChunkSchema = z.infer<
  typeof dictationAudioChunkSchema
>;
export type DictationAudioChunk = z.infer<typeof dictationAudioChunkSchema>;
