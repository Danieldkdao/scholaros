import type { NavigationContextPackage } from './navigation-context';
import type { CourseMaterialSearchResultSchema } from '../schemas';

const maxPassages = 8;
const maxAcademicCharacters = 16_000;

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

export const createAcademicContextPackage = ({
  navigation,
  search,
  maxAcademicCharacters: requestedCharacters = maxAcademicCharacters,
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

  const characterLimit = Math.min(requestedCharacters, maxAcademicCharacters);
  let characters = 0;
  let truncated = search.truncated || search.passages.length > maxPassages;
  const passages: CourseMaterialSearchResultSchema['passages'] = [];
  for (const passage of search.passages.slice(0, maxPassages)) {
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
