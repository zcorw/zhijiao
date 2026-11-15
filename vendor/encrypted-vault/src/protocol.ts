import { z } from 'zod';
z.config({ jitless: true });

export const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => BigInt(v) <= 9223372036854775807n);
export const opaqueId = z.string().uuid();
export const laneSchema = z.enum(['directory','records','assets']);
export type Lane = z.infer<typeof laneSchema>;
export const envelopeSchema = z.strictObject({
  vaultId: opaqueId, recordId: opaqueId, revision: decimal,
  keyVersion: z.number().int().min(1).max(1000000), formatVersion: z.literal(1),
  lane: laneSchema, tombstone: z.boolean(),
  variant: z.enum(['main','thumb']).optional(),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z.string().min(24).max(6000000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
});
export type CipherEnvelope = z.infer<typeof envelopeSchema>;
export const operationSchema = z.strictObject({ operationId: opaqueId, mutations: z.array(z.strictObject({ expectedRevision: decimal, envelope: envelopeSchema })).min(1).max(100) });
export type Operation = z.infer<typeof operationSchema>;
export interface ChangePage { envelopes: CipherEnvelope[]; after: string; highWatermark: string; hasMore: boolean }
export interface OperationResult { operationId: string; envelopes: CipherEnvelope[]; cursor: string }
export interface VaultDescriptor { id: string; ownerId: string; keyBundle: unknown; keyBundleRevision: string }

/** Deterministic authenticated routing metadata. Never rewrite these fields on the server. */
export function aad(e: Omit<CipherEnvelope, 'nonce' | 'ciphertext'>): string {
  return JSON.stringify(['zhijiao', e.vaultId, e.recordId, e.revision, e.formatVersion, e.keyVersion, e.lane, e.tombstone, e.variant ?? null]);
}
