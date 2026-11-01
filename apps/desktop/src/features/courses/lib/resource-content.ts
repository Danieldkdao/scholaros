import type { ExtractedCourseSchema } from '@scholaros/services/ai/resources/course';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ExtractedAssignmentSchema } from '@scholaros/services/ai/resources/assignment';
import type { ExtractedAnnouncementSchema } from '@scholaros/services/ai/resources/announcement';
import type { ResourceKind } from '@scholaros/services/ai/resources/shared';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseChildItem } from '../types';

export const resourceRequest = ({
  page,
  kind,
  goal,
  notes,
  host,
  allowedHosts = [host],
  courseUrl,
  courseName,
  truncated = false,
}: {
  page: ObservedPage;
  kind: ResourceKind;
  goal: string;
  notes: string;
  host: string;
  allowedHosts?: string[];
  courseUrl: string | null;
  courseName: string | null;
  truncated?: boolean;
}): AgentRequestSchema & {
  context: NonNullable<AgentRequestSchema['context']>;
} => {
  const links = page.links.filter((link) =>
    isReadNavigation(link.url, allowedHosts),
  );
  return {
    kind,
    goal,
    notes,
    context: {
      retrievedAt: page.retrievedAt ?? new Date().toISOString(),
      observedTimezone: null,
      locale: page.locale ?? null,
      courseUrl,
      courseName,
      truncated:
        truncated ||
        !!page.linksTruncated ||
        links.length > 80 ||
        (page.text?.length ?? 0) > 16000,
    },
    pages: [
      {
        url: page.url,
        title: page.title.slice(0, 500),
        text: (page.text ?? '').slice(0, 16000),
      },
    ],
    targets: links.slice(0, 80).map((link, index) => ({
      id: String(index + 1),
      label: link.label.slice(0, 300),
      url: link.url,
    })),
  };
};

export const resourceItem = (
  content: ExtractedAssignmentSchema | ExtractedAnnouncementSchema,
  retrievedAt?: string,
): CourseChildItem => {
  const date = 'due' in content ? content.due : content.published;
  return {
    title: content.title,
    retrievedAt,
    body: 'description' in content ? content.description : content.body,
    dateValue:
      date?.kind === 'instant'
        ? date.instant
        : date?.kind === 'date'
          ? date.date
          : null,
    dateText: date?.original ?? null,
    url: content.url ?? content.evidence.sourceUrl,
    content,
  };
};

export const courseFieldsFromExtraction = (content: ExtractedCourseSchema) => ({
  name: content.name,
  code: content.code,
  term: content.term,
  instructor: content.instructors.join(', ') || null,
  description: content.description,
  externalId: content.sourceId,
  content,
});
