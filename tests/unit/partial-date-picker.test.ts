import { describe, expect, it } from 'vitest';
import { changePrecision, datePrecision, fromPickerValue, pickerStart, toPickerValue, localCalendarDate } from '../../apps/web/src/partial-date-picker.js';

describe('partial-date picker boundary', () => {
  it('round trips years/months/days with their exact known precision', () => {
    for (const value of ['0001', '0078', '1900-02', '2024-02-29', '2026-10-12', '9999-12-31']) {
      const precision = datePrecision(value);
      expect(fromPickerValue(toPickerValue(value, precision), precision)).toBe(value);
    }
  });
  it('drops only explicitly reduced precision and never invents missing month/day', () => {
    expect(changePrecision('2024-02-29', 'month')).toBe('2024-02');
    expect(changePrecision('2024-02-29', 'year')).toBe('2024');
    expect(changePrecision('2024-02', 'year')).toBe('2024');
    for (const [value, mode] of [['2024', 'month'], ['2024', 'day'], ['2024-02', 'day']] as const) expect(changePrecision(value, mode)).toBe('');
  });
  it('keeps empty, malformed and unknown-year old values out of the calendar selection', () => {
    for (const value of ['', '--02-29', '0000', '2025-02-29', '2024-13', '2024-01-32', '10000', '2024x']) {
      expect(toPickerValue(value, datePrecision(value))).toBe(null);
      expect(changePrecision(value, 'year')).toBe('');
    }
  });
  it('validates picker output before it can be emitted to storage', () => {
    expect(fromPickerValue({ year: 2024, month: 1 }, 'month')).toBe('2024-02');
    for (const value of [-1, 0, 10000, 1.5, NaN]) expect(fromPickerValue(value, 'year')).toBe(null);
    for (const value of [{year: 2024, month: -1}, {year: 2024, month: 12}, {year: 2024, month: 1.5}, {year: '2024', month: 1}]) expect(fromPickerValue(value, 'month')).toBe(null);
    expect(fromPickerValue(new Date(NaN), 'day')).toBe(null);
    expect(fromPickerValue(null, 'day')).toBe(null);
  });
  it('uses local calendar fields across time zones and the 0-99 constructor boundary', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Europe/Berlin']) {
        process.env.TZ = zone;
        for (const value of ['0078-03-01', '2024-03-10', '2024-11-03', '2024-02-29']) expect(fromPickerValue(toPickerValue(value, 'day'), 'day')).toBe(value);
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
    expect(localCalendarDate(78, 2, 1).getFullYear()).toBe(78);
  });
  it('positions the calendar without converting that view date to a chosen record', () => {
    expect(pickerStart('2024').getFullYear()).toBe(2024);
    expect(pickerStart('2024-02').getMonth()).toBe(1);
    expect(toPickerValue('2024', 'day')).toBe(null);
    expect(toPickerValue('2024-02', 'day')).toBe(null);
  });
  it('never silently selects another day when a historical time zone skipped the civil date', () => {
    const previous = process.env.TZ;
    try { process.env.TZ = 'Pacific/Apia'; expect(toPickerValue('2011-12-30', 'day')).toBe(null); }
    finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
});
