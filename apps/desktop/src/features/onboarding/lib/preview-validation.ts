import { validateResourceExtraction } from '@scholaros/services/ai/resources/validation';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { PreviewCard, PreviewCardKind, PreviewPrompt } from '../types';

export const previewKindForPrompt = (
  prompt: PreviewPrompt,
): PreviewCardKind => {
  switch (prompt) {
    case 'courses':
      return 'course';
    case 'assignments':
      return 'assignment';
    case 'announcements':
      return 'announcement';
  }
};

export const validatePreviewCards = (
  input: unknown,
  request: AgentRequestSchema,
): PreviewCard[] => {
  const kind = request.kind;
  if (kind !== 'courses' && kind !== 'assignments' && kind !== 'announcements')
    throw new Error('Choose a resource to preview.');
  const result = validateResourceExtraction(request, kind, input);
  const resources =
    'courses' in result
      ? result.courses
      : 'assignments' in result
        ? result.assignments
        : result.announcements;
  return resources.map((resource): PreviewCard => {
    const date =
      'due' in resource
        ? resource.due
        : 'published' in resource
          ? resource.published
          : null;
    return {
      kind: previewKindForPrompt(kind),
      title: 'name' in resource ? resource.name : resource.title,
      course: request.context?.courseName ?? null,
      detail: 'description' in resource ? resource.description : resource.body,
      date: date?.original ?? null,
      sourceUrl: resource.evidence.sourceUrl,
      excerpt: resource.evidence.excerpts.join(' '),
      courseVerified: !!request.context?.courseName,
      dateVerified: !!date && date.kind !== 'unresolved',
    };
  });
};
