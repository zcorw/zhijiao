import { z } from 'zod';

export const partialDateSchema = z.string().regex(/^(\d{4}(-\d{2}(-\d{2})?)?|--\d{2}-\d{2})$/).refine(v => {
  const parts = v.startsWith('--') ? ['2000', ...v.slice(2).split('-')] : v.split('-');
  const year = Number(parts[0]); const month = Number(parts[1] ?? '1'); const day = Number(parts[2] ?? '1');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}, '日期不合法；未知年份可用 --MM-DD');
