import { previewResultSchema } from '../schemas';
import type {
  EvidencePage,
  PreviewCard,
  PreviewCardKind,
  PreviewPrompt,
} from '../types';

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

const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const stripTitlePunctuation = (value: string) =>
  value.replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,:;!?]+$/g, '');

const phraseAppears = (source: string, phrase: string) => {
  const text = normalize(source);
  const needle = normalize(phrase);
  if (!needle) return false;
  for (
    let index = text.indexOf(needle);
    index >= 0;
    index = text.indexOf(needle, index + 1)
  ) {
    const before = text[index - 1];
    const after = text[index + needle.length];
    if (
      (!before || !/[\p{L}\p{N}]/u.test(before)) &&
      (!after || !/[\p{L}\p{N}]/u.test(after))
    )
      return true;
  }
  return false;
};

const titleMatches = (text: string, title: string) => {
  const needle = stripTitlePunctuation(normalize(title));
  return needle.length > 0 && phraseAppears(text, needle);
};

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const monthPattern =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const weekdayPattern = /\b(?:sun|mon|tues|wednes|thurs|fri|satur)day\b,?/gi;
const monthDayPattern = new RegExp(
  `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'gi',
);
const isoDatePattern = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const numericDatePattern = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;

const monthNames = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const monthIndex = (name: string) => {
  const normalized = name.toLowerCase();
  return monthNames.findIndex(
    (month) =>
      month === normalized ||
      (normalized === 'sept' && month === 'september') ||
      month.startsWith(normalized.slice(0, 3)),
  );
};

type DateParts = { month: number; day: number; year: number | null };

const validDate = (month: number, day: number) =>
  month >= 0 && month < 12 && day >= 1 && day <= 31;

const parseDate = (value: string): DateParts | null => {
  const cleaned = value
    .replace(weekdayPattern, ' ')
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    return validDate(month, day) ? { month, day, year: Number(iso[1]) } : null;
  }
  const monthDay = cleaned.match(
    new RegExp(`^(${monthPattern})\\s+(\\d{1,2})(?:\\s+(\\d{4}))?$`, 'i'),
  );
  if (monthDay) {
    const month = monthIndex(monthDay[1]!);
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : null;
    return validDate(month, day) ? { month, day, year } : null;
  }
  const numeric = cleaned.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const rawYear = numeric[3];
    const year = rawYear
      ? rawYear.length === 2
        ? Number(rawYear) + (Number(rawYear) >= 70 ? 1900 : 2000)
        : Number(rawYear)
      : null;
    return validDate(month, day) ? { month, day, year } : null;
  }
  return null;
};

const evidenceDates = (text: string): DateParts[] => {
  const dates: DateParts[] = [];
  for (const match of text.matchAll(monthDayPattern)) {
    const month = monthIndex(match[1]!);
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : null;
    if (validDate(month, day)) dates.push({ month, day, year });
  }
  for (const match of text.matchAll(isoDatePattern)) {
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const year = Number(match[1]);
    if (validDate(month, day)) dates.push({ month, day, year });
  }
  for (const match of text.matchAll(numericDatePattern)) {
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : null;
    if (validDate(month, day)) dates.push({ month, day, year });
  }
  return dates;
};

export const dateIsGrounded = (date: string, text: string) => {
  const normalizedDate = normalize(date);
  if (!normalizedDate) return false;
  if (phraseAppears(text, normalizedDate)) return true;
  const requested = parseDate(date);
  if (!requested) return false;
  return evidenceDates(text).some(
    (candidate) =>
      candidate.month === requested.month &&
      candidate.day === requested.day &&
      (requested.year === null || candidate.year === requested.year),
  );
};

// Generated prose is displayed only when it is also a source quotation.
const summaryIsSupported = (summary: string, text: string) =>
  phraseAppears(text, summary);

const itemEvidence = (text: string, title: string) => {
  const source = collapseWhitespace(text);
  const start = source
    .toLowerCase()
    .indexOf(collapseWhitespace(title).toLowerCase());
  if (start < 0) return '';
  const tail = source.slice(start + title.length);
  const end = tail.search(/[.!?](?:\s|$)/);
  return source.slice(
    start,
    start + title.length + (end < 0 ? Math.min(tail.length, 600) : end),
  );
};

const excerptFor = (text: string, title: string) => {
  const lowerText = text.toLowerCase();
  const needle = collapseWhitespace(title).toLowerCase();
  const index = lowerText.indexOf(needle);
  if (index < 0) return text.slice(0, 280).trim();
  const start = Math.max(0, index - 90);
  const end = Math.min(text.length, index + needle.length + 240);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${
    end < text.length ? '…' : ''
  }`;
};

export const validatePreviewCards = (
  input: unknown,
  evidence: EvidencePage[],
  expectedKind: PreviewCardKind,
): PreviewCard[] => {
  const parsed = previewResultSchema.safeParse(input);
  if (!parsed.success) throw new Error('The results could not be verified.');
  return parsed.data.cards.flatMap((card) => {
    if (card.kind !== expectedKind) return [];
    const page = evidence.find((item) => item.url === card.sourceUrl);
    if (!page || !titleMatches(page.text, card.title)) return [];
    const title = collapseWhitespace(card.title);
    const course =
      card.course && titleMatches(page.text, card.course)
        ? collapseWhitespace(card.course)
        : null;
    const date =
      card.date &&
      dateIsGrounded(card.date, itemEvidence(page.text, card.title))
        ? collapseWhitespace(card.date)
        : null;
    const detail =
      card.detail && summaryIsSupported(card.detail, page.text)
        ? collapseWhitespace(card.detail)
        : null;
    return [
      {
        kind: card.kind,
        title,
        course,
        detail,
        date,
        sourceUrl: card.sourceUrl,
        excerpt: excerptFor(page.text, title),
        courseVerified: course !== null,
        dateVerified: date !== null,
      },
    ];
  });
};
