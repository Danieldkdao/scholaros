import { z } from 'zod';
import { extractedCourseSchema, type ExtractedCoursesSchema } from './course';
import {
  extractedAssignmentSchema,
  type ExtractedAssignmentsSchema,
} from './assignment';
import {
  extractedAnnouncementSchema,
  type ExtractedAnnouncementsSchema,
} from './announcement';
import {
  contentCoverageValues,
  type AcademicDateSchema,
  type ResourceKind,
  type SourceEvidenceSchema,
  type ResourceLinkSchema,
} from './shared';
import type { AgentRequestSchema } from '../schemas';

type ResourceResults = {
  courses: ExtractedCoursesSchema;
  assignments: ExtractedAssignmentsSchema;
  announcements: ExtractedAnnouncementsSchema;
};
const normalize = (value: string) =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();
const realDate = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
};
const validDate = (
  date: AcademicDateSchema | null,
  input: AgentRequestSchema,
) => {
  if (!date) return true;
  if (
    !input.pages.some((page) =>
      normalize(`${page.title} ${page.text}`).includes(
        normalize(date.original),
      ),
    )
  )
    return false;
  if (date.kind === 'unresolved') return true;
  if (date.kind === 'date') return realDate(date.date);
  if (date.kind === 'local')
    return (
      realDate(date.date) &&
      /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(date.time)
    );
  const offset = /(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(
    date.instant,
  );
  const timezone = date.timezone;
  const sourceTimezone =
    timezone &&
    input.pages.some((page) =>
      normalize(page.text).includes(normalize(timezone)),
    );
  if (date.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: date.timezone });
    } catch {
      return false;
    }
  }
  const establishedZone =
    !!input.context?.observedTimezone ||
    sourceTimezone ||
    /\b(?:UTC|GMT)\b|[+-]\d{2}:?\d{2}|Z$/i.test(date.original);
  return (
    realDate(date.instant.slice(0, 10)) &&
    offset &&
    Number.isFinite(Date.parse(date.instant)) &&
    establishedZone
  );
};

const validateRecords = <
  T extends {
    url: string | null;
    evidence: SourceEvidenceSchema;
    resources?: ResourceLinkSchema[];
  },
>(
  input: AgentRequestSchema,
  schema: z.ZodType<T>,
  raw: unknown,
  coverage: string,
) => {
  const items: T[] = [];
  let invalid = !Array.isArray(raw);
  for (const value of Array.isArray(raw) ? raw.slice(0, 30) : []) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      invalid = true;
      continue;
    }
    const item = parsed.data;
    const page = input.pages.find(
      (page) => page.url === item.evidence.sourceUrl,
    );
    const source = normalize(
      `${page?.title ?? ''} ${page?.text ?? ''} ${(input.targets ?? []).map((target) => target.label).join(' ')}`,
    );
    const targets = input.targets ?? [];
    const observedUrl =
      item.url === null ||
      (item.url === page?.url
        ? coverage === 'detail' && Array.isArray(raw) && raw.length === 1
        : targets.some(
            (target) =>
              target.url === item.url &&
              item.evidence.targetIds.includes(target.id),
          ));
    const heading =
      'name' in item ? item.name : 'title' in item ? item.title : '';
    const validEvidence =
      !!page &&
      typeof heading === 'string' &&
      /[\p{L}\p{N}]/u.test(heading) &&
      source.includes(normalize(heading)) &&
      item.evidence.excerpts.every((excerpt) =>
        source.includes(normalize(excerpt)),
      ) &&
      item.evidence.targetIds.every((id) =>
        targets.some((target) => target.id === id),
      );
    const validLinks = (item.resources ?? []).every(
      (link) =>
        item.evidence.targetIds.includes(link.targetId) &&
        targets.some(
          (target) => target.id === link.targetId && target.url === link.url,
        ),
    );
    let validDates = true;
    for (const field of [
      'due',
      'availableFrom',
      'availableUntil',
      'published',
      'updated',
    ] as const) {
      if (
        field in item &&
        !validDate(
          (item as Record<string, unknown>)[field] as AcademicDateSchema | null,
          input,
        )
      )
        validDates = false;
    }
    if (!validEvidence || !observedUrl || !validLinks || !validDates) {
      invalid = true;
      continue;
    }
    items.push(item);
  }
  return {
    items,
    invalid: invalid || (Array.isArray(raw) && raw.length >= 30),
  };
};

export const validateResourceExtraction = <TKind extends ResourceKind>(
  input: AgentRequestSchema,
  kind: TKind,
  raw: unknown,
): ResourceResults[TKind] => {
  const envelope = z
    .object({ coverage: z.enum(contentCoverageValues) })
    .parse(raw);
  const collection = (raw as Record<string, unknown>)[kind];
  const result =
    kind === 'courses'
      ? validateRecords(
          input,
          extractedCourseSchema,
          collection,
          envelope.coverage,
        )
      : kind === 'assignments'
        ? validateRecords(
            input,
            extractedAssignmentSchema,
            collection,
            envelope.coverage,
          )
        : validateRecords(
            input,
            extractedAnnouncementSchema,
            collection,
            envelope.coverage,
          );
  const partial =
    result.invalid ||
    input.context?.truncated ||
    (envelope.coverage === 'unavailable' && result.items.length > 0) ||
    (envelope.coverage === 'detail' && result.items.length !== 1);
  return {
    [kind]: result.items,
    coverage: partial ? 'partial' : envelope.coverage,
  } as ResourceResults[TKind];
};
