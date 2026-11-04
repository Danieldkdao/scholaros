import {
  Ban,
  BookOpen,
  BookOpenCheck,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleOff,
  History,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type {
  MemoryDTO,
  MemoryProvenance,
  MemoryType,
  ObservationOutcome,
  PreferenceField,
} from '@scholaros/services/learning/memory-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { MemoryStatus } from '../hooks/use-memory';

export const formatMemoryType = (type: MemoryType) => {
  switch (type) {
    case 'explicit-preference':
      return { label: 'Explicit preference', Icon: CircleCheck };
    case 'provisional-preference':
      return { label: 'Provisional preference', Icon: CircleHelp };
    case 'learning-observation':
      return { label: 'Learning observation', Icon: BookOpen };
  }
};

export const formatMemoryProvenance = (provenance: MemoryProvenance) => {
  switch (provenance) {
    case 'student-explicit':
      return { label: 'You told ScholarOS', Icon: UserRound };
    case 'meta-inferred':
      return { label: 'Inferred from study patterns', Icon: Sparkles };
    case 'practice-evidence':
      return { label: 'Practice evidence', Icon: BookOpenCheck };
  }
};

export const formatPreferenceField = (field: PreferenceField) => {
  switch (field) {
    case 'explanation-length':
      return { label: 'Explanation length', Icon: CircleDashed };
    case 'vocabulary':
      return { label: 'Vocabulary', Icon: BookOpen };
    case 'example-style':
      return { label: 'Example style', Icon: Sparkles };
    case 'learning-level':
      return { label: 'Learning level', Icon: CircleHelp };
  }
};

export const formatObservationOutcome = (outcome: ObservationOutcome) => {
  switch (outcome) {
    case 'independent-success':
      return { label: 'Independent success', Icon: CircleCheck };
    case 'assisted-success':
      return { label: 'Assisted success', Icon: BookOpenCheck };
    case 'difficulty':
      return { label: 'Difficulty observed', Icon: CircleAlert };
    case 'uncertain':
      return { label: 'Uncertain evidence', Icon: CircleHelp };
  }
};

export const formatMemoryContent = (memory: MemoryDTO) => {
  if ('field' in memory.content) {
    return {
      title: formatPreferenceField(memory.content.field).label,
      description: memory.content.value,
    };
  }
  return {
    title: formatObservationOutcome(memory.content.outcome).label,
    description: memory.content.summary,
  };
};

export const formatMemoryScope = (
  courseId: string | null,
  courseName?: string | null,
) => {
  if (courseId === null) return { label: 'Account-wide', Icon: UserRound };
  return {
    label: courseName ? `Course: ${courseName}` : 'Course-specific',
    Icon: BookOpen,
  };
};

export const formatSourceReferenceState = (state: SourceReference['state']) => {
  switch (state) {
    case 'current':
      return { label: 'Current source', Icon: CircleCheck };
    case 'historical':
      return { label: 'Historical source', Icon: History };
    case 'removed':
      return { label: 'Removed source', Icon: CircleOff };
    case 'unavailable':
      return { label: 'Source unavailable', Icon: Ban };
  }
};

export const formatSourceLocator = (locator: SourceReference['locator']) => {
  if (!locator) return null;
  switch (locator.kind) {
    case 'page':
      return `Page ${locator.page}`;
    case 'heading':
      return locator.heading;
    case 'paragraph':
      return `Paragraph ${locator.ordinal}`;
  }
};

export const formatMemoryLoadStatus = (status: MemoryStatus) => {
  switch (status) {
    case 'idle':
      return { label: 'Not loaded', Icon: CircleDashed };
    case 'loading':
      return { label: 'Loading remembered information', Icon: CircleDashed };
    case 'loading-more':
      return {
        label: 'Loading more remembered information',
        Icon: CircleDashed,
      };
    case 'ready':
      return { label: 'Remembered information loaded', Icon: CircleCheck };
    case 'error':
      return { label: 'Remembered information unavailable', Icon: CircleAlert };
    case 'offline':
      return {
        label: 'Remembered information unavailable offline',
        Icon: CircleOff,
      };
  }
};

export const formatEvidenceCount = (count: number) =>
  count === 1 ? '1 evidence record' : `${count} evidence records`;

export const formatUnknownProgressCount = (count: number) =>
  count === 1
    ? '1 topic without enough evidence yet'
    : `${count} topics without enough evidence yet`;
