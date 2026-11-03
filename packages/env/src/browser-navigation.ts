import { z } from 'zod';

export const browserNavigationModeValues = ['decision', 'inout'] as const;
export type BrowserNavigationMode =
  (typeof browserNavigationModeValues)[number];
export const browserNavigationModeSchema = z.enum(browserNavigationModeValues);

export const browserNavigationCapabilitySchema = z
  .object({ browserNavigationMode: browserNavigationModeSchema })
  .strict();
export type BrowserNavigationCapability = z.infer<
  typeof browserNavigationCapabilitySchema
>;
