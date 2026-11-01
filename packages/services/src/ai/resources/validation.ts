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
  courses: ExtractedCoursesSchema & { detailRecord?: true };
  assignments: ExtractedAssignmentsSchema & { detailRecord?: true };
  announcements: ExtractedAnnouncementsSchema & { detailRecord?: true };
};
type DateRole =
  | 'due'
  | 'availableFrom'
  | 'availableUntil'
  | 'published'
  | 'updated';
type DateEvidence = {
  pageUrl: string;
  regions: string[];
  excerpts: string[];
  timezoneRegions: string[];
};
type SourceTime = { value: string; secondsSpecified: boolean };
type SourceTimezone =
  | { kind: 'offset'; minutes: number; label: string }
  | { kind: 'conflict' };
type SourceTimestamp = {
  epoch: number;
  value: string;
  timezone: Extract<SourceTimezone, { kind: 'offset' }>;
};
type RoleMarker = { start: number; end: number; roles: DateRole[] };

const normalize = (value: string) =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();
const realDate = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
};
const months = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];
const dateRolePattern = (role: DateRole) => {
  switch (role) {
    case 'due':
      return /\b(?:due|deadline|submit(?:ted)? by|submission due)\b/i;
    case 'availableFrom':
      return /\b(?:opens?|opening|available from|starts?|begin(?:s|ning)?)\b/i;
    case 'availableUntil':
      return /\b(?:closes?|closing|available until|ends?|deadline|due)\b/i;
    case 'published':
      return /\b(?:published|posted|announced|announcement date|released|created)\b/i;
    case 'updated':
      return /\b(?:updated|edited|modified|revised|last updated)\b/i;
  }
};

const dateRoles: DateRole[] = [
  'due',
  'availableFrom',
  'availableUntil',
  'published',
  'updated',
];

const splitEvidenceSentence = (value: string) => {
  const sentence = normalize(value);
  const regions: string[] = [];
  let start = 0;
  for (const match of sentence.matchAll(/[.!?;]\s+/g)) {
    const index = match.index ?? 0;
    const prefix = sentence.slice(start, index);
    const period = sentence[index] === '.';
    if (
      period &&
      /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[ap]\.m)$/i.test(
        prefix,
      )
    )
      continue;
    regions.push(prefix.trim());
    start = index + match[0].length;
  }
  regions.push(sentence.slice(start).trim());
  return regions.filter(Boolean);
};

const dateEvidenceRegions = ({ regions }: { regions: string[] }) =>
  regions.flatMap((region) =>
    region.split(/\r?\n+/).flatMap(splitEvidenceSentence),
  );

const originalPattern = (original: string) => {
  const text = normalize(original).replace(/[\s.,;:!?]+$/, '');
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
};

const textOccurrences = (value: string, query: string) =>
  [
    ...normalize(value).matchAll(
      new RegExp(originalPattern(query).source, 'giu'),
    ),
  ].length;

const itemEvidenceRegion = (
  value: string,
  heading: string,
  targets: NonNullable<AgentRequestSchema['targets']>,
  includeFollowingSentences: boolean,
) => {
  if (textOccurrences(value, heading) !== 1) return null;
  const normalizedValue = normalize(value);
  const region = includeFollowingSentences
    ? normalizedValue
    : dateEvidenceRegions({ regions: [value] }).find((candidate) =>
        originalPattern(heading).test(candidate),
      );
  if (!region) return null;
  const headingMatch = originalPattern(heading).exec(region);
  if (!headingMatch) return null;
  const headingEnd = headingMatch.index + headingMatch[0].length;
  const nextItemStart = targets
    .filter(
      (target) =>
        normalize(target.label) !== normalize(heading) &&
        /[\p{L}\p{N}]/u.test(target.label),
    )
    .flatMap((target) => {
      const match = originalPattern(target.label).exec(region);
      return match && match.index >= headingEnd ? [match.index] : [];
    })
    .sort((left, right) => left - right)[0];
  const itemRegion = region.slice(headingMatch.index, nextItemStart);
  const markers = roleMarkers(itemRegion);
  const repeatedRole = dateRoles.some(
    (role) =>
      markers.filter((marker) => marker.roles.includes(role)).length > 1,
  );
  // Broad target context can contain neighbors; prefer the heading's own metadata then.
  if (includeFollowingSentences && repeatedRole)
    return (
      dateEvidenceRegions({ regions: [itemRegion] }).find((candidate) =>
        originalPattern(heading).test(candidate),
      ) ?? null
    );
  return itemRegion;
};

const dateSegmentsForOriginal = (original: string, evidence: DateEvidence) => {
  const pattern = originalPattern(original);
  return dateEvidenceRegions(evidence).filter((region) => pattern.test(region));
};

const roleMarkers = (region: string) => {
  const markers = new Map<string, RoleMarker>();
  for (const role of dateRoles) {
    const source = dateRolePattern(role);
    const pattern = new RegExp(source.source, `${source.flags}g`);
    for (const match of region.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const key = `${start}:${end}`;
      const marker = markers.get(key) ?? { start, end, roles: [] };
      marker.roles.push(role);
      markers.set(key, marker);
    }
  }
  return [...markers.values()];
};

const roleMatchesAt = (region: string, position: number, role: DateRole) => {
  const markers = roleMarkers(region);
  if (!markers.length) return false;
  const distance = (marker: RoleMarker) =>
    position < marker.start
      ? marker.start - position
      : position > marker.end
        ? position - marker.end
        : 0;
  const nearestDistance = Math.min(...markers.map(distance));
  const nearestMarkers = markers.filter(
    (marker) => distance(marker) === nearestDistance,
  );
  return nearestMarkers.every((marker) => marker.roles.includes(role));
};

const hasDateRole = (
  original: string,
  role: DateRole,
  evidence: DateEvidence,
) => {
  const pattern = originalPattern(original);
  return dateSegmentsForOriginal(original, evidence).some((region) => {
    const match = pattern.exec(region);
    return match ? roleMatchesAt(region, match.index, role) : false;
  });
};

const dateRoleIsAmbiguous = (
  original: string,
  role: DateRole,
  evidence: DateEvidence,
) =>
  evidence.regions.some((region) => {
    if (!originalPattern(original).test(region)) return false;
    const markers = roleMarkers(normalize(region)).filter((marker) =>
      marker.roles.includes(role),
    );
    return markers.length > 1;
  });

const sourceDate = (
  original: string,
  evidence: DateEvidence,
  input: AgentRequestSchema,
) => {
  const iso = original.match(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1];
  if (iso) return realDate(iso) ? iso : null;

  const matchingSegments = dateSegmentsForOriginal(original, evidence);
  const monthDay = original.match(
    /\b(january|jan\.?|february|feb\.?|march|mar\.?|april|apr\.?|may|june|jun\.?|july|jul\.?|august|aug\.?|september|sept?\.?|october|oct\.?|november|nov\.?|december|dec\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
  );
  if (monthDay) {
    const month = months.findIndex((names) =>
      names.some((name) => name === monthDay[1].replace('.', '').toLowerCase()),
    );
    const nearbyYear = matchingSegments
      .map((segment) => {
        const index = originalPattern(original).exec(segment)?.index ?? 0;
        return segment
          .slice(
            Math.max(0, index - 40),
            index + normalize(original).length + 40,
          )
          .match(/\b(?:19|20)\d{2}\b/)?.[0];
      })
      .find(Boolean);
    const monthDayValue = `${String(month + 1).padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
    const year = monthDay[3] ?? nearbyYear;
    if (!year || month < 0) return null;
    const date = `${year}-${monthDayValue}`;
    return realDate(date) ? date : null;
  }

  const numeric = original.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (numeric) {
    const page = input.pages.find(
      (candidate) => candidate.url === evidence.pageUrl,
    );
    const locale = page?.locale ?? input.context?.locale ?? '';
    if (!/^en[-_]US\b/i.test(locale)) return null;
    const date = `${numeric[3]}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
    return realDate(date) ? date : null;
  }
  return null;
};

const sourceTimezoneToken = (value: string): SourceTimezone => {
  const normalized = value.toUpperCase();
  if (normalized === 'Z' || normalized === 'UTC' || normalized === 'GMT')
    return { kind: 'offset', minutes: 0, label: 'UTC' };
  const match = value.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return { kind: 'conflict' };
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return { kind: 'conflict' };
  return {
    kind: 'offset',
    minutes: (hours * 60 + minutes) * (match[1] === '-' ? -1 : 1),
    label: `${match[1]}${match[2]}:${match[3]}`,
  };
};

const sourceTimestamp = (original: string): SourceTimestamp | null => {
  const match = original.match(
    /(?<![\p{L}\p{N}])(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})(?![\p{L}\p{N}])/iu,
  );
  const value = match ? `${match[1]}${match[2]}` : null;
  if (!value || !realDate(value.slice(0, 10))) return null;
  const timezone = sourceTimezoneToken(match![2]!);
  if (timezone.kind === 'conflict') return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? { epoch, value, timezone } : null;
};

const sourceTimezone = (
  original: string,
  timestamp = sourceTimestamp(original),
): SourceTimezone | null => {
  const remainder = timestamp
    ? original.replace(timestamp.value, '')
    : original;
  const parsedRemainderTokens = [
    ...remainder.matchAll(
      /\b(?:UTC|GMT)\b|(?<![\p{L}])Z(?![\p{L}\p{N}])|(?<!\d)[+-]\d{2}:?\d{2}(?!\d)/giu,
    ),
  ].map((match) => sourceTimezoneToken(match[0]));
  if (parsedRemainderTokens.some((timezone) => timezone.kind === 'conflict'))
    return { kind: 'conflict' };
  const tokens = [
    ...(timestamp ? [timestamp.timezone] : []),
    ...parsedRemainderTokens.filter(
      (timezone): timezone is Extract<SourceTimezone, { kind: 'offset' }> =>
        timezone.kind === 'offset',
    ),
  ];
  const distinctOffsets = new Set(tokens.map(({ minutes }) => minutes));
  if (distinctOffsets.size > 1) return { kind: 'conflict' };
  return tokens[0] ?? null;
};

const sourceTimezoneForDate = (
  original: string,
  evidence: DateEvidence,
  timestamp: SourceTimestamp | null,
): SourceTimezone | null => {
  const direct = sourceTimezone(original, timestamp);
  if (direct?.kind === 'conflict') return direct;
  const adjacent = dateSegmentsForOriginal(original, evidence).flatMap(
    (region) => {
      const occurrence = originalPattern(original).exec(region);
      if (!occurrence) return [];
      const suffix = region.slice(occurrence.index + occurrence[0].length);
      const timezone = suffix.match(
        /^\s*(?:(?:at\s+)?\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:a\.?m\.?|p\.?m\.?)?\s*)?(?:timezone\s*[:=]?\s*)?(UTC|GMT|Z|[+-]\d{2}:?\d{2})\s*[.,;!?]*\s*$/i,
      )?.[1];
      if (!timezone) return [];
      const parsed = sourceTimezone(timezone);
      return parsed?.kind === 'offset' ? [parsed] : [];
    },
  );
  const zones = [...(direct?.kind === 'offset' ? [direct] : []), ...adjacent];
  const distinctOffsets = new Set(zones.map(({ minutes }) => minutes));
  if (distinctOffsets.size > 1) return { kind: 'conflict' };
  return zones[0] ?? null;
};

const namedTimezoneFromEvidence = (evidence: DateEvidence) => {
  const names = new Set<string>();
  for (const region of dateEvidenceRegions({
    regions: [...evidence.regions, ...evidence.timezoneRegions],
  })) {
    for (const match of region.matchAll(
      /\b(?:[a-z_+-]+\/)+[a-z0-9_+.-]+\b/giu,
    )) {
      const timezone = validTimezone(match[0]);
      if (timezone) names.add(timezone);
    }
  }
  return names.size === 1 ? [...names][0] : names.size > 1 ? 'conflict' : null;
};

const sourceEpochFromLocalTime = (
  date: string,
  time: SourceTime,
  timezone: Extract<SourceTimezone, { kind: 'offset' }>,
) => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = '0'] = time.value.split(':');
  const epoch = Date.UTC(
    year,
    month - 1,
    day,
    Number(hour),
    Number(minute),
    Number(second),
  );
  return epoch - timezone.minutes * 60_000;
};

const sourceTimes = (
  original: string,
  evidence: DateEvidence,
  role: DateRole,
): SourceTime[] => {
  const values = new Map<string, SourceTime>();
  const addTime = (
    region: string,
    index: number,
    rawHour: number,
    minute: number,
    second: number,
    meridian: string | undefined,
    secondsSpecified: boolean,
  ) => {
    if (!roleMatchesAt(region, index, role)) return;
    if (minute > 59 || second > 59 || rawHour > (meridian ? 12 : 23)) return;
    if (meridian && (rawHour === 0 || rawHour < 1)) return;
    const hour = meridian
      ? (rawHour % 12) + (meridian === 'pm' ? 12 : 0)
      : rawHour;
    const minuteValue = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const value = secondsSpecified
      ? `${minuteValue}:${String(second).padStart(2, '0')}`
      : minuteValue;
    values.set(`${value}:${secondsSpecified}`, { value, secondsSpecified });
  };
  for (const region of dateSegmentsForOriginal(original, evidence)) {
    const isoTimestamp =
      /\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi;
    for (const match of region.matchAll(isoTimestamp))
      addTime(
        region,
        match.index ?? 0,
        Number(match[1]),
        Number(match[2]),
        Number(match[3] ?? 0),
        undefined,
        !!match[3],
      );

    const time =
      /(?<![tT+\-\d])\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
    for (const match of region.matchAll(time))
      addTime(
        region,
        match.index ?? 0,
        Number(match[1]),
        Number(match[2]),
        Number(match[3] ?? 0),
        match[4]?.replaceAll('.', '').toLowerCase(),
        !!match[3],
      );

    const minuteOnly = /(?<!:)\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi;
    for (const match of region.matchAll(minuteOnly)) {
      const rawHour = Number(match[1]);
      if (rawHour < 1 || rawHour > 12) continue;
      addTime(
        region,
        match.index ?? 0,
        rawHour,
        0,
        0,
        match[2].replaceAll('.', '').toLowerCase(),
        false,
      );
    }
  }
  return [...values.values()];
};

const normalizedTime = (value: string) => {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match
    ? {
        value: `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ''}`,
        minuteValue: `${match[1]}:${match[2]}`,
        secondsSpecified: !!match[3],
      }
    : null;
};

const timeMatches = (expected: SourceTime, actual: string) => {
  const normalized = normalizedTime(actual);
  if (!normalized) return false;
  return expected.secondsSpecified
    ? normalized.value === expected.value
    : normalized.minuteValue === expected.value.slice(0, 5);
};

const validTimezone = (timezone: string | null | undefined) => {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

const localPartsFromInstant = (instant: string, timezone: string | null) => {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return null;
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(parsed);
      const value = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((part) => part.type === type)?.value;
      return {
        date: `${value('year')}-${value('month')}-${value('day')}`,
        time: `${value('hour')}:${value('minute')}:${value('second')}`,
      };
    } catch {
      return null;
    }
  }
  const offset = instant.match(/([+-])(\d{2}):(\d{2})$/);
  if (!offset && !instant.endsWith('Z')) return null;
  const offsetMinutes = offset
    ? (Number(offset[2]) * 60 + Number(offset[3])) *
      (offset[1] === '-' ? -1 : 1)
    : 0;
  const local = new Date(parsed + offsetMinutes * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 19) };
};

const unresolved = (original: string, reason: string): AcademicDateSchema => ({
  kind: 'unresolved',
  original,
  reason,
});

const validateDate = (
  date: AcademicDateSchema | null,
  role: DateRole,
  evidence: DateEvidence,
  input: AgentRequestSchema,
): AcademicDateSchema | null | undefined => {
  if (!date) return null;
  const matchingSegments = dateSegmentsForOriginal(date.original, evidence);
  const hasDatedExcerpt = evidence.excerpts.some(
    (excerpt) =>
      originalPattern(date.original).test(excerpt) &&
      evidence.regions.some((region) => {
        const normalizedExcerpt = normalize(excerpt).replace(
          /[\s.,;:!?]+$/,
          '',
        );
        const normalizedRegion = normalize(region);
        return (
          normalizedRegion.includes(normalizedExcerpt) ||
          normalizedExcerpt.startsWith(normalizedRegion)
        );
      }),
  );
  if (
    !matchingSegments.length ||
    !hasDatedExcerpt ||
    !hasDateRole(date.original, role, evidence)
  )
    return undefined;
  if (dateRoleIsAmbiguous(date.original, role, evidence)) return undefined;
  if (date.kind === 'unresolved') return date;

  const groundedDate = sourceDate(date.original, evidence, input);
  if (!groundedDate)
    return unresolved(
      date.original,
      'The source wording does not establish a calendar year.',
    );
  if (
    !realDate(date.kind === 'instant' ? date.instant.slice(0, 10) : date.date)
  )
    return undefined;
  if (date.kind === 'date')
    return date.date === groundedDate ? date : undefined;

  const times = sourceTimes(date.original, evidence, role);
  if (times.length !== 1) return undefined;
  const sourceTime = times[0];
  if (date.kind === 'local') {
    if (date.date !== groundedDate || !timeMatches(sourceTime, date.time))
      return undefined;
    return date;
  }

  const sourceIsoTimestamp = sourceTimestamp(date.original);
  const sourceZone = sourceTimezoneForDate(
    date.original,
    evidence,
    sourceIsoTimestamp,
  );
  if (sourceZone?.kind === 'conflict')
    return unresolved(
      date.original,
      'The source gives conflicting timezone information.',
    );
  const targetEpoch = Date.parse(date.instant);
  if (!Number.isFinite(targetEpoch)) return undefined;
  if (sourceIsoTimestamp) {
    if (sourceIsoTimestamp.epoch !== targetEpoch) return undefined;
    return { ...date, timezone: sourceIsoTimestamp.timezone.label };
  }
  if (sourceZone?.kind === 'offset') {
    const sourceEpoch = sourceEpochFromLocalTime(
      groundedDate,
      sourceTime,
      sourceZone,
    );
    const precision = sourceTime.secondsSpecified ? 1 : 60_000;
    if (
      Math.floor(sourceEpoch / precision) !==
      Math.floor(targetEpoch / precision)
    )
      return undefined;
    return { ...date, timezone: sourceZone.label };
  }

  const evidenceTimezone = namedTimezoneFromEvidence(evidence);
  if (evidenceTimezone === 'conflict')
    return unresolved(
      date.original,
      'The source gives conflicting timezone information.',
    );
  const observedTimezone = validTimezone(input.context?.observedTimezone);
  const namedTimezone = evidenceTimezone ?? null;
  if (!namedTimezone && !observedTimezone)
    return unresolved(
      date.original,
      'The source wording does not establish a timezone.',
    );
  const instantParts = localPartsFromInstant(
    date.instant,
    namedTimezone ?? observedTimezone,
  );
  if (
    !instantParts ||
    instantParts.date !== groundedDate ||
    !timeMatches(sourceTime, instantParts.time)
  )
    return undefined;
  if (namedTimezone) return { ...date, timezone: namedTimezone };
  if (observedTimezone) return { ...date, timezone: observedTimezone };
  return date;
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
  carriedDetailRecord: boolean,
) => {
  const items: T[] = [];
  let invalid = !Array.isArray(raw);
  const records = Array.isArray(raw) ? raw.slice(0, 30) : [];
  const singleDetailEvidence =
    Array.isArray(raw) &&
    raw.length === 1 &&
    (coverage === 'detail' || carriedDetailRecord);
  for (const value of records) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      invalid = true;
      continue;
    }
    const item = parsed.data;
    const page = input.pages.find(
      (candidate) => candidate.url === item.evidence.sourceUrl,
    );
    const targets = input.targets ?? [];
    const headingValue =
      'name' in item ? item.name : 'title' in item ? item.title : '';
    const heading = typeof headingValue === 'string' ? headingValue : '';
    const sourceTargets = targets.filter((target) =>
      item.evidence.targetIds.includes(target.id),
    );
    const source = normalize(
      `${page?.title ?? ''} ${page?.text ?? ''} ${sourceTargets
        .map((target) => `${target.label} ${target.context ?? ''}`)
        .join(' ')}`,
    );
    const targetRegions = sourceTargets.flatMap((target) => {
      if (target.url !== item.url || !target.context) return [];
      const region = itemEvidenceRegion(target.context, heading, targets, true);
      return region ? [region] : [];
    });
    const detailPage =
      !!page &&
      item.url === page.url &&
      textOccurrences(page.title, heading) === 1;
    const pageRegion = page
      ? itemEvidenceRegion(page.text, heading, targets, false)
      : null;
    const sourceExcerpts =
      !!page &&
      item.evidence.excerpts.every(
        (excerpt) =>
          normalize(page.text).includes(normalize(excerpt)) ||
          sourceTargets.some(
            (target) =>
              !!target.context &&
              normalize(target.context).includes(normalize(excerpt)),
          ),
      );
    const timezoneMetadataExcerpt = (excerpt: string) =>
      /\b(?:course|class)\s+timezone\b/i.test(excerpt) &&
      /\b(?:[a-z_+-]+\/)+[a-z0-9_+.-]+\b/iu.test(excerpt);
    const itemRegions = detailPage
      ? [page.title, ...item.evidence.excerpts]
      : targetRegions.length === 1
        ? [targetRegions[0]!]
        : pageRegion
          ? [pageRegion]
          : [];
    const observedUrl =
      item.url === null ||
      (item.url === page?.url
        ? detailPage
        : targets.some(
            (target) =>
              target.url === item.url &&
              item.evidence.targetIds.includes(target.id),
          ));
    const validEvidence =
      !!page &&
      /[\p{L}\p{N}]/u.test(heading) &&
      source.includes(normalize(heading)) &&
      sourceExcerpts &&
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
    const evidence: DateEvidence = {
      pageUrl: item.evidence.sourceUrl,
      regions: itemRegions,
      excerpts: item.evidence.excerpts,
      timezoneRegions:
        itemRegions.length > 0
          ? item.evidence.excerpts.filter(timezoneMetadataExcerpt)
          : [],
    };
    const validatedItem = { ...item } as T & Record<string, unknown>;
    let validDates = true;
    for (const [field, role] of [
      ['due', 'due'],
      ['availableFrom', 'availableFrom'],
      ['availableUntil', 'availableUntil'],
      ['published', 'published'],
      ['updated', 'updated'],
    ] as const) {
      if (!(field in item)) continue;
      const checked = validateDate(
        (item as Record<string, unknown>)[field] as AcademicDateSchema | null,
        role,
        evidence,
        input,
      );
      if (checked === undefined) validDates = false;
      else (validatedItem as Record<string, unknown>)[field] = checked;
    }
    if (!validEvidence || !observedUrl || !validLinks || !validDates) {
      invalid = true;
      continue;
    }
    items.push(validatedItem);
  }
  return {
    items,
    invalid: invalid || (Array.isArray(raw) && raw.length >= 30),
    detailRecord: singleDetailEvidence && items.length === 1,
  };
};

export const validateResourceExtraction = <TKind extends ResourceKind>(
  input: AgentRequestSchema,
  kind: TKind,
  raw: unknown,
): ResourceResults[TKind] => {
  const envelope = z
    .object({
      coverage: z.enum(contentCoverageValues),
      detailRecord: z.literal(true).optional(),
    })
    .parse(raw);
  const collection = (raw as Record<string, unknown>)[kind];
  const result =
    kind === 'courses'
      ? validateRecords(
          input,
          extractedCourseSchema,
          collection,
          envelope.coverage,
          envelope.detailRecord === true,
        )
      : kind === 'assignments'
        ? validateRecords(
            input,
            extractedAssignmentSchema,
            collection,
            envelope.coverage,
            envelope.detailRecord === true,
          )
        : validateRecords(
            input,
            extractedAnnouncementSchema,
            collection,
            envelope.coverage,
            envelope.detailRecord === true,
          );
  const partial =
    result.invalid ||
    input.context?.truncated ||
    (envelope.coverage === 'unavailable' && result.items.length > 0) ||
    (envelope.coverage === 'detail' && result.items.length !== 1);
  return {
    [kind]: result.items,
    coverage: partial ? 'partial' : envelope.coverage,
    ...(partial && result.detailRecord ? { detailRecord: true as const } : {}),
  } as ResourceResults[TKind];
};
