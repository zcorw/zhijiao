import { z } from 'zod';

// Browser validation must work under script-src 'self' without dynamic evaluation.
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
export interface SessionSummary { id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string }
export interface AccountView { id: string; login: string; displayName: string; status: 'active' | 'disabled' }

export const partialDateSchema = z.string().regex(/^(\d{4}(-\d{2}(-\d{2})?)?|--\d{2}-\d{2})$/).refine(v => {
  const parts = v.startsWith('--') ? ['2000', ...v.slice(2).split('-')] : v.split('-');
  const year = Number(parts[0]); const month = Number(parts[1] ?? '1'); const day = Number(parts[2] ?? '1');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}, '日期不合法；未知年份可用 --MM-DD');
export type PartialDate = string;
export interface EntityBase { id: string; ownerId: string; createdAt: string; updatedAt: string }
export interface AvatarKeyEnvelope { nonce: string; ciphertext: string }
export interface AvatarRef { main: { id: string; revision: string; keyEnvelope?: AvatarKeyEnvelope }; thumb: { id: string; revision: string; keyEnvelope?: AvatarKeyEnvelope }; keyVersion: number }
export interface Person extends EntityBase { kind: 'person'; displayName: string; fullName?: string; aliases?: string[]; avatar?: AvatarRef; summary?: string; metContext?: string; metOn?: PartialDate; birthday?: PartialDate; notes?: string; status: 'active' | 'archived' }
export interface DirectoryEntry extends EntityBase { kind: 'directory'; personId: string; displayName: string; aliases: string[]; distinguishing?: string; avatar?: AvatarRef; status: 'active' | 'archived' }
export interface ContactMethod extends EntityBase { kind: 'contact'; personId: string; type: string; value: string; label?: string; preferred?: boolean; status: 'active' | 'inactive' | 'unconfirmed' }
export interface PersonFact extends EntityBase { kind: 'fact'; personId: string; category?: string; content: string; basis: 'self-reported' | 'observation' | 'third-party'; sourceNote?: string; sourceInteractionId?: string; learnedOn?: PartialDate; validFrom?: PartialDate; validTo?: PartialDate; status: 'current' | 'unconfirmed' | 'outdated'; supersedesFactId?: string }
/** An empty participantIds array is a complete interaction without a person association. */
export interface Interaction extends EntityBase { kind: 'interaction'; title: string; participantIds: string[]; kindOfInteraction?: string; occurredOn?: PartialDate; occurredAt?: string; timezone?: string; channel?: string; location?: string; content: string }
export interface PersonReflection extends EntityBase { kind: 'reflection'; personId: string; type: 'feeling' | 'hypothesis' | 'experience'; content: string; context?: string; evidence?: string; counterEvidence?: string; certainty?: string; recordedOn?: PartialDate; status: 'current' | 'revised' | 'withdrawn'; supersedesId?: string }
export interface ReflectionInteraction extends EntityBase { kind: 'reflectionLink'; reflectionId: string; interactionId: string; relationType: 'arose' | 'supports' | 'contradicts' | 'revises'; explanation?: string }
export interface FollowUp extends EntityBase { kind: 'followUp'; title: string; personIds: string[]; type: 'promise' | 'plan'; responsibility: 'me' | 'other' | 'joint'; sourceInteractionId?: string; details?: string; dueDate?: PartialDate; dueAt?: string; timezone?: string; status: 'pending' | 'completed' | 'cancelled'; completedAt?: string }
export interface Tag extends EntityBase { kind: 'tag'; name: string; color?: string }
export interface PersonTag extends EntityBase { kind: 'personTag'; personId: string; tagId: string }
export type Entity = Person | DirectoryEntry | ContactMethod | PersonFact | Interaction | PersonReflection | ReflectionInteraction | FollowUp | Tag | PersonTag;

/** Deterministic authenticated routing metadata. Never rewrite these fields on the server. */
export function aad(e: Omit<CipherEnvelope, 'nonce' | 'ciphertext'>): string {
  return JSON.stringify(['zhijiao', e.vaultId, e.recordId, e.revision, e.formatVersion, e.keyVersion, e.lane, e.tombstone, e.variant ?? null]);
}
