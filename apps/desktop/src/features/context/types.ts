import type { MaterialSourceType } from '@scholaros/services/ai/resources/material';
import type { CourseMaterialSearchResultSchema } from './schemas';
import type { NavigationContextPackage } from './lib/navigation-context';

export const navigationPurposes = [
  'courses',
  'assignments',
  'announcements',
  'materials',
] as const;
export type NavigationPurpose = (typeof navigationPurposes)[number];

export const resourceIdentityKinds = ['assignments', 'announcements'] as const;
export type ResourceIdentityKind = (typeof resourceIdentityKinds)[number];

export const navigationLocationStatuses = [
  'tentative',
  'verified',
  'stale',
] as const;
export type NavigationLocationStatus =
  (typeof navigationLocationStatuses)[number];

export const navigationDestinationKinds = [
  'summary',
  'collection',
  'detail',
] as const;
export type NavigationDestinationKind =
  (typeof navigationDestinationKinds)[number];

export const navigationFailureClasses = [
  'not-found',
  'wrong-account',
  'wrong-course',
  'missing-control',
  'rate-limited',
  'needs-sign-in',
  'network',
  'unknown',
] as const;
export type NavigationFailureClass = (typeof navigationFailureClasses)[number];

export type NavigationRecipeStep =
  | { kind: 'open-url'; url: string }
  | { kind: 'click-link'; label: string; url: string }
  | { kind: 'reveal-section'; label: string; targetId: string };

export type NavigationRecipe = {
  version: 1;
  steps: NavigationRecipeStep[];
};

export type NavigationEvidence = {
  sourceUrl: string;
  excerpts: string[];
  targetIds: string[];
};

export type CourseMaterialSourceType = MaterialSourceType;

export const courseMaterialExtractionStatuses = [
  'pending',
  'complete',
  'partial',
  'unreadable',
  'failed',
] as const;
export type CourseMaterialExtractionStatus =
  (typeof courseMaterialExtractionStatuses)[number];

export const courseMaterialUsableStatuses = ['complete', 'partial'] as const;
export type CourseMaterialUsableStatus =
  (typeof courseMaterialUsableStatuses)[number];

export type CourseMaterialAttempt = {
  status: CourseMaterialExtractionStatus;
  attemptedAt: string | null;
};

export type CourseMaterialCurrentVersion = {
  contentHash: string;
  status: CourseMaterialUsableStatus;
  sourceUrl: string;
  retrievedAt: string | null;
  verifiedAt: string | null;
  contentChangedAt: string | null;
};

export type CourseMaterialState = {
  latestAttempt: CourseMaterialAttempt | null;
  currentVersion: CourseMaterialCurrentVersion | null;
};

export type CourseMaterialSummaryEvidence = {
  sourceUrl: string;
  excerpts: string[];
  locator: string | null;
};

export type AcademicContextPackage = {
  navigation: NavigationContextPackage;
  academic: {
    passages: CourseMaterialSearchResultSchema['passages'];
    characters: number;
    retrievalMs: number;
    truncated: boolean;
  };
  truncated: boolean;
};
