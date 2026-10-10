import { describe, it, expect, vi } from 'vitest';
import type { FollowUp } from '@zhijiao/shared';
import { isOverdue, localDate, dateLabel } from './format';
const base: FollowUp = { id:'9b9ac119-f208-4ab4-aec9-f33f55cf04be', ownerId:'336fa14d-c9df-4dc5-bf30-e84f66c0ec36', createdAt:'2026-10-10T12:00:00Z', updatedAt:'2026-10-10T12:00:00Z', kind:'followUp', title:'虚构测试约定', personIds:['ca5ba5ce-f662-45a9-ab39-fc829e467a1c'], type:'promise', responsibility:'me', status:'pending' };
describe('date precision and derived overdue', () => {
 it('does not invent a year for birthdays or day for partial dates', () => { expect(dateLabel('--05-12')).toBe('05月12日'); expect(dateLabel('2026-05')).toBe('2026-05'); expect(dateLabel('2026')).toBe('2026'); });
 it('only derives overdue from a precise usable deadline', () => {
   vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
   expect(isOverdue(base)).toBe(false); expect(isOverdue({...base,dueDate:'2026-01'})).toBe(false);
   expect(isOverdue({...base,dueDate:'2026-01-01'})).toBe(true); expect(isOverdue({...base,dueDate:localDate()})).toBe(false);
   expect(isOverdue({...base,dueAt:'2026-10-10T11:59:00Z'})).toBe(true);
   expect(isOverdue({...base,dueAt:'2026-10-10T12:01:00Z'})).toBe(false);
   expect(isOverdue({...base,dueDate:'2026-01-01',status:'completed'})).toBe(false); expect(isOverdue({...base,dueDate:'2026-01-01',status:'cancelled'})).toBe(false);
   vi.useRealTimers();
 });
});
