import type { NavigationLocationSelectData } from '../../../db/schema';
import { navigationContextLimits } from '../constants';
import { navigationLocationRowSchema } from '../schemas';
import type { NavigationPurpose } from '../types';

export type NavigationContextOptions = {
  userId: string;
  connectionId: string;
  courseId: string | null;
  purpose: NavigationPurpose;
  maxLocations?: number;
  maxCharacters?: number;
};

export type NavigationContextPackage = {
  purpose: NavigationPurpose;
  courseId: string | null;
  locations: NavigationLocationSelectData[];
  truncated: boolean;
  serialized: string;
};

const statusRank = (status: NavigationLocationSelectData['status']) => {
  switch (status) {
    case 'verified':
      return 0;
    case 'tentative':
      return 1;
    case 'stale':
      return 2;
  }
};

export const createNavigationContext = (
  input: NavigationLocationSelectData[],
  options: NavigationContextOptions,
): NavigationContextPackage | null => {
  const maxLocations = Math.min(
    options.maxLocations ?? navigationContextLimits.maxRecords,
    navigationContextLimits.maxRecords,
  );
  const maxCharacters = Math.min(
    options.maxCharacters ?? navigationContextLimits.maxSerializedCharacters,
    navigationContextLimits.maxSerializedCharacters,
  );
  if (
    !Number.isInteger(maxLocations) ||
    maxLocations < 0 ||
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 256
  )
    return null;
  let truncated = false;
  const scopedLocations: NavigationLocationSelectData[] = [];
  for (const location of input) {
    const parsed = navigationLocationRowSchema.safeParse(location);
    if (!parsed.success) {
      truncated = true;
      continue;
    }
    const navigationLocation = parsed.data;
    if (
      navigationLocation.userId !== options.userId ||
      navigationLocation.connectionId !== options.connectionId ||
      navigationLocation.purpose !== options.purpose ||
      (navigationLocation.courseId !== null &&
        navigationLocation.courseId !== options.courseId)
    ) {
      truncated = true;
      continue;
    }
    if (location.recipe && !navigationLocation.recipe) truncated = true;
    scopedLocations.push(navigationLocation);
  }
  scopedLocations.sort(
    (left, right) =>
      statusRank(left.status) - statusRank(right.status) ||
      Number(right.courseId === options.courseId) -
        Number(left.courseId === options.courseId) ||
      right.observedAt.localeCompare(left.observedAt) ||
      left.destinationUrl.localeCompare(right.destinationUrl),
  );
  const selected = scopedLocations.slice(0, maxLocations);
  if (selected.length < scopedLocations.length) truncated = true;
  const contextLocations = selected.map((location) => ({
    id: location.id,
    status: location.status,
    destinationKind: location.destinationKind,
    destinationUrl: location.destinationUrl,
    parentUrl: location.parentUrl,
    label: location.label,
    recipe: location.recipe
      ? {
          version: location.recipe.version,
          steps: location.recipe.steps.slice(
            0,
            navigationContextLimits.maxRecipeSteps,
          ),
        }
      : null,
    evidence: {
      sourceUrl: location.evidence.sourceUrl,
      excerpts: location.evidence.excerpts
        .slice(0, navigationContextLimits.maxExcerptCount)
        .map((excerpt) =>
          excerpt.slice(0, navigationContextLimits.maxExcerptCharacters),
        ),
      targetIds: location.evidence.targetIds.slice(
        0,
        navigationContextLimits.maxTargetIdCount,
      ),
    },
    observedAt: location.observedAt,
    verifiedAt: location.verifiedAt,
  }));
  if (
    contextLocations.some(
      (location, index) =>
        location.recipe?.steps.length !==
          selected[index]?.recipe?.steps.length ||
        location.evidence.excerpts.length !==
          selected[index]?.evidence.excerpts.length ||
        location.evidence.targetIds.length !==
          selected[index]?.evidence.targetIds.length ||
        location.evidence.excerpts.some(
          (excerpt, excerptIndex) =>
            excerpt.length !==
            selected[index]?.evidence.excerpts[excerptIndex]?.length,
        ),
    )
  )
    truncated = true;
  const serialize = (locations: typeof contextLocations) =>
    JSON.stringify({
      purpose: options.purpose,
      courseId: options.courseId,
      truncated,
      locations,
    });
  let serialized = serialize(contextLocations);
  while (serialized.length > maxCharacters && contextLocations.length) {
    contextLocations.pop();
    truncated = true;
    serialized = serialize(contextLocations);
  }
  if (serialized.length > maxCharacters) return null;
  const selectedIds = new Set(contextLocations.map((location) => location.id));
  return {
    purpose: options.purpose,
    courseId: options.courseId,
    locations: selected.filter((location) => selectedIds.has(location.id)),
    truncated,
    serialized,
  };
};
