import { describe, it, expect } from 'vitest';
import { aad, partialDateSchema, decimal, envelopeSchema } from '../../packages/shared/src/index.js';
describe('authenticated metadata and partial dates', () => {
  it('keeps unknown years absent and validates calendar precision', () => {
    for (const value of ['2026','2026-10','2024-02-29','0004-02-29','--02-29']) expect(partialDateSchema.parse(value)).toBe(value);
    for (const value of ['2025-02-29','0100-02-29','--02-30','2026-00','2026-13','2026-01-32','0000','2026-1']) expect(partialDateSchema.safeParse(value).success).toBe(false);
  });
  it('keeps PostgreSQL bigint exact over the JSON boundary', () => {
    expect(decimal.parse('9007199254740993')).toBe('9007199254740993');
    expect(decimal.safeParse('9223372036854775808').success).toBe(false);
    expect(decimal.safeParse('01').success).toBe(false);
  });
  it('binds all routing and version fields into AAD', () => {
    const e = { vaultId: crypto.randomUUID(), recordId: crypto.randomUUID(), revision: '1', keyVersion: 1, formatVersion: 1 as const, lane: 'records' as const, tombstone: false };
    for (const altered of [{ ...e, revision: '2' }, { ...e, recordId: crypto.randomUUID() }, { ...e, vaultId: crypto.randomUUID() }, { ...e, keyVersion: 2 }, { ...e, lane: 'assets' as const }, { ...e, variant: 'thumb' as const }, { ...e, tombstone: true }]) expect(aad(altered)).not.toBe(aad(e));
    expect(envelopeSchema.safeParse({...e, nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(24), ownerId: crypto.randomUUID()}).success).toBe(false);
  });
});
