import { z } from 'zod';
import {
  maxWatchUrlLength,
  maxWatchUrls,
  watchTargetStatuses,
} from './constants';

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
