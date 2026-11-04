import type { NavigationContextPackage } from './navigation-context';
import type { CourseMaterialSearchResultSchema } from '../schemas';
import {
  academicContextMaxCharacters,
  academicContextMaxPassages,
} from '../constants';
import type { AcademicContextPackage } from '../types';

export type { AcademicContextPackage } from '../types';

export const createAcademicContextPackage = ({
  navigation,
  search,
  maxAcademicCharacters: requestedCharacters = academicContextMaxCharacters,
}: {
  navigation: NavigationContextPackage | null;
  search: CourseMaterialSearchResultSchema | null;
  maxAcademicCharacters?: number;
}): AcademicContextPackage | null => {
  if (
    !navigation ||
    !search ||
    !Number.isInteger(requestedCharacters) ||
    requestedCharacters < 0
  )
    return null;

  const characterLimit = Math.min(
    requestedCharacters,
    academicContextMaxCharacters,
  );
  let characters = 0;
  let truncated =
    search.truncated || search.passages.length > academicContextMaxPassages;
  const passages: CourseMaterialSearchResultSchema['passages'] = [];
  for (const passage of search.passages.slice(0, academicContextMaxPassages)) {
    const remaining = characterLimit - characters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = passage.text.slice(0, remaining);
    if (text.length < passage.text.length) truncated = true;
    if (!text.trim()) {
      truncated = true;
      continue;
    }
    passages.push({ ...passage, text });
    characters += text.length;
  }

  return {
    navigation,
    academic: {
      passages,
      characters,
      retrievalMs: search.retrievalMs,
      truncated,
    },
    truncated: navigation.truncated || truncated,
  };
};
