import { z } from 'zod';
import {
  maxWatchUrlLength,
  maxWatchUrls,
  watchTargetStatuses,
} from './constants';
import { watchTargetFailureCategories } from '../../db/shared';
import { watchRuntimeStatuses } from './types';

export const watchUrlInputSchema = z
  .object({ url: z.string().max(maxWatchUrlLength) })
  .strict();
export type WatchUrlInputSchema = z.infer<typeof watchUrlInputSchema>;

export const watchUrlsSchema = z
  .array(z.string().max(maxWatchUrlLength))
  .max(maxWatchUrls);
export type WatchUrlsSchema = z.infer<typeof watchUrlsSchema>;

export const watchSettingsSchema = z
  .object({
    watchEnabled: z.boolean(),
    watchUrls: watchUrlsSchema,
  })
  .strict();
export type WatchSettingsSchema = z.infer<typeof watchSettingsSchema>;

export const watchTargetStatusSchema = z.enum(watchTargetStatuses);
export type WatchTargetStatusSchema = z.infer<typeof watchTargetStatusSchema>;

export const watchRuntimeStatusSchema = z.enum(watchRuntimeStatuses);
export type WatchRuntimeStatusSchema = z.infer<typeof watchRuntimeStatusSchema>;

export const watchTargetFailureCategorySchema = z.enum(
  watchTargetFailureCategories,
);
export type WatchTargetFailureCategorySchema = z.infer<
  typeof watchTargetFailureCategorySchema
>;

export const watchTargetFailureSchema = z.strictObject({
  category: watchTargetFailureCategorySchema,
  targetCount: z.number().int().min(1).max(10_000),
});
export type WatchTargetFailureSchema = z.infer<typeof watchTargetFailureSchema>;

export const watchHealthSummarySchema = z.strictObject({
  status: watchRuntimeStatusSchema,
  pendingRevisionCount: z.number().int().min(0).max(10_000),
  oldestPendingSince: z.iso.datetime({ offset: true }).nullable(),
  oldestPendingSinceEstimated: z.boolean(),
  lastSuccessfulCheckAt: z.iso.datetime({ offset: true }).nullable(),
  nextRetryAt: z.iso.datetime({ offset: true }).nullable(),
  failures: z
    .array(watchTargetFailureSchema)
    .max(watchTargetFailureCategories.length),
});
export type WatchHealthSummarySchema = z.infer<typeof watchHealthSummarySchema>;
