import { partialDateSchema } from '@zhijiao/shared';

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** The same browser-local civil time as the former datetime-local input, at minute precision. */
export function toDateTimePicker(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || !partialDateSchema.safeParse(match[1]).success) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  const hours = Number(match[2]), minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, 0, 0);
  // Reject normalization of an impossible civil date/time, including a DST gap.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hours && date.getMinutes() === minutes ? date : null;
}

export function fromDateTimePicker(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  const result = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
  return toDateTimePicker(result) ? result : null;
}

/** Preserve the existing UTC-to-browser-local edit conversion, without parsing date-only strings. */
export function editDateTime(value: string): string {
  return fromDateTimePicker(new Date(value)) ?? value;
}
