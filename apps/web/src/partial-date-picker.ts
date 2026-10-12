import { partialDateSchema } from '@zhijiao/shared';

export type DatePrecision = 'day' | 'month' | 'year';
export type PickerValue = Date | { month: number; year: number } | number | null;
const pad = (value: number, length = 2) => String(value).padStart(length, '0');
const knownYear = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

export function datePrecision(value: string): DatePrecision {
  return /^\d{4}$/.test(value) ? 'year' : /^\d{4}-\d{2}$/.test(value) ? 'month' : 'day';
}

/** A local calendar date, never a UTC parse of YYYY-MM-DD. Noon also avoids midnight DST gaps. */
export function localCalendarDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}

export function toPickerValue(value: string, precision: DatePrecision): PickerValue {
  if (!knownYear.test(value) || !partialDateSchema.safeParse(value).success) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (precision === 'year') return year;
  if (month === undefined) return null;
  if (precision === 'month') return { year, month: month - 1 };
  if (day === undefined) return null;
  const date = localCalendarDate(year, month - 1, day);
  // Some historical time zones skipped an entire civil day. Never select its replacement day.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function fromPickerValue(value: unknown, precision: DatePrecision): string | null {
  let result: string;
  if (precision === 'year' && Number.isInteger(value)) result = pad(value as number, 4);
  else if (precision === 'month' && value && typeof value === 'object' && 'year' in value && 'month' in value
    && Number.isInteger(value.year) && Number.isInteger(value.month)) {
    result = `${pad(value.year as number, 4)}-${pad((value.month as number) + 1)}`;
  } else if (precision === 'day' && value instanceof Date && Number.isFinite(value.getTime())) {
    result = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  } else return null;
  return knownYear.test(result) && partialDateSchema.safeParse(result).success ? result : null;
}

/** Reducing precision may keep known parts; increasing it requires an explicit selection. */
export function changePrecision(value: string, precision: DatePrecision): string {
  const picker = toPickerValue(value, precision);
  return picker === null ? '' : fromPickerValue(picker, precision) ?? '';
}

export function pickerStart(value: string): Date {
  if (knownYear.test(value) && partialDateSchema.safeParse(value).success) {
    const [year, month = 1, day = 1] = value.split('-').map(Number);
    return localCalendarDate(year, month - 1, day); // View position only; never emitted as a selected value.
  }
  return new Date();
}
