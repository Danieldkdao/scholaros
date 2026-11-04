import { z } from 'zod';

export const browserNavigationModeValues = ['decision', 'inout'] as const;
export type BrowserNavigationMode =
  (typeof browserNavigationModeValues)[number];
export const browserNavigationModeSchema = z.enum(browserNavigationModeValues);
export type BrowserNavigationModeSchema = z.infer<
  typeof browserNavigationModeSchema
>;

export const browserNavigationCapabilitySchema = z
  .object({ browserNavigationMode: browserNavigationModeSchema })
  .strict();
export type BrowserNavigationCapabilitySchema = z.infer<
  typeof browserNavigationCapabilitySchema
>;
export type BrowserNavigationCapability = z.infer<
  typeof browserNavigationCapabilitySchema
>;
