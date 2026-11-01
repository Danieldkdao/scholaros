import { format, parseISO, startOfDay } from 'date-fns';
import {
  academicDateSchema,
  type AcademicDateSchema,
} from '@scholaros/services/ai/resources/shared';
import type { CourseChildItem } from '../types';

export const legacyDateFrom = ({
  dateValue,
  dateText,
}: {
  dateValue: string | null;
  dateText: string | null;
}): AcademicDateSchema | null => {
  const original = dateText?.trim() || dateValue;
  if (!original) return null;
  if (
    dateValue &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(dateValue)
  ) {
    const parsed = academicDateSchema.safeParse({
      kind: 'local',
      date: dateValue.slice(0, 10),
      time: dateValue.slice(11),
      original,
    });
    if (parsed.success) return parsed.data;
  }
  if (dateValue) {
    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
      ? { kind: 'date', date: dateValue, original }
      : { kind: 'instant', instant: dateValue, timezone: null, original };
    const parsed = academicDateSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return {
    kind: 'unresolved',
    original,
    reason: 'Refresh this source to establish its date.',
  };
};

export const dateValueFrom = (date: AcademicDateSchema | null) => {
  if (!date) return null;
  switch (date.kind) {
    case 'date':
      return date.date;
    case 'instant':
      return date.instant;
    case 'local':
      return `${date.date}T${date.time}`;
    case 'unresolved':
      return null;
  }
};

export const academicDateFor = (
  item: Pick<CourseChildItem, 'content' | 'dateValue' | 'dateText'>,
): AcademicDateSchema | null => {
  if (item.content)
    return 'due' in item.content ? item.content.due : item.content.published;
  return legacyDateFrom(item);
};

export const isPastDateInput = (value: string, now = new Date()) => {
  if (!value) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return value < format(startOfDay(now), 'yyyy-MM-dd');
  return parseISO(value).getTime() < now.getTime();
};
