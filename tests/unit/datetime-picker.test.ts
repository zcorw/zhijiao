import { describe, expect, it } from 'vitest';
import { validate } from 'vee-validate';
import { editDateTime, fromDateTimePicker, toDateTimePicker } from '../../apps/web/src/datetime-picker.js';
import { datetimeRule } from '../../apps/web/src/validation.js';

describe('exact date/time picker and form validation', () => {
  it('round trips local civil fields across time zones, leap days and years 1–99', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Europe/Berlin']) {
        process.env.TZ = zone;
        for (const value of ['0001-01-02T00:00', '0078-03-01T09:05', '2024-02-29T23:59', '9999-12-31T12:00']) {
          const picked = toDateTimePicker(value);
          expect(fromDateTimePicker(picked)).toBe(value);
          expect(editDateTime(picked!.toISOString())).toBe(value);
          expect(picked!.toISOString()).toBe(new Date(value).toISOString());
        }
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('does not accept date-only, UTC, partial or normalized invalid input as local exact time', async () => {
    for (const value of ['2024', '--02-29', '2024-02-29', '2025-02-29T10:30', '2024-02-30T10:30', '2024-13-01T10:30', '2024-01-01T24:00', '2024-01-01T12:60', '0000-01-01T10:30', '10000-01-01T10:30', '2024-01-01T10:30Z', '2024-01-01T10:30:12', 'nonsense']) {
      expect(toDateTimePicker(value)).toBe(null);
      expect((await validate(value, datetimeRule)).valid).toBe(false);
    }
    for (const value of ['', '  ', '2024-02-29T10:30', ' 2024-02-29T10:30 ']) expect((await validate(value, datetimeRule)).valid).toBe(true);
    expect(fromDateTimePicker(new Date(NaN))).toBe(null);
    expect(fromDateTimePicker({hours: 10, minutes: 30})).toBe(null);
  });
  it('rejects skipped times instead of silently normalizing through a DST gap', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(toDateTimePicker('2024-03-10T02:30')).toBe(null);
      expect(fromDateTimePicker(toDateTimePicker('2024-03-10T03:30'))).toBe('2024-03-10T03:30');
      expect(fromDateTimePicker(toDateTimePicker('2024-11-03T01:30'))).toBe('2024-11-03T01:30');
      process.env.TZ = 'Pacific/Apia'; expect(toDateTimePicker('2011-12-30T12:00')).toBe(null);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('retains existing minute edit precision and leaves malformed legacy values visible for correction', () => {
    expect(editDateTime('malformed-legacy-time')).toBe('malformed-legacy-time');
    const date = toDateTimePicker('2024-02-29T10:30')!; date.setSeconds(42);
    expect(editDateTime(date.toISOString())).toBe('2024-02-29T10:30');
  });
});
