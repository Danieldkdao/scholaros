const monthNames = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
// Only a timestamp carrying its own zone is unambiguous enough to store.
const zonedTimestampPattern =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const namedDatePattern =
  /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/;

const isRealDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const pad = (value: number) => String(value).padStart(2, '0');

// Ambiguous dates stay as source wording rather than becoming guessed deadlines.
export const storedDateFrom = (
  raw: string | null,
): { dateValue: string | null; dateText: string | null } => {
  const text = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return { dateValue: null, dateText: null };
  if (
    zonedTimestampPattern.test(text) &&
    isRealDate(+text.slice(0, 4), +text.slice(5, 7), +text.slice(8, 10)) &&
    !Number.isNaN(Date.parse(text))
  )
    return { dateValue: text, dateText: null };
  const isoDate = dateOnlyPattern.exec(text);
  if (isoDate && isRealDate(+isoDate[1], +isoDate[2], +isoDate[3]))
    return { dateValue: text, dateText: null };
  const namedDate = namedDatePattern.exec(text);
  if (namedDate) {
    const month =
      monthNames.indexOf(namedDate[1].slice(0, 3).toLowerCase()) + 1;
    const day = +namedDate[2];
    const year = +namedDate[3];
    if (month && isRealDate(year, month, day)) {
      const dateValue = `${year}-${pad(month)}-${pad(day)}`;
      return {
        dateValue,
        dateText: dateValue === text ? null : text,
      };
    }
  }
  return { dateValue: null, dateText: text };
};
