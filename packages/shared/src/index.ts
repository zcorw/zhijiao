import { z } from 'zod';
export { partialDateSchema } from './partial-date.js';
export * from './interaction-analysis.js';
export * from './interaction-analysis-errors.js';
export * from './interaction-analysis-settings.js';

// Browser validation must work under script-src 'self' without dynamic evaluation.
z.config({ jitless: true });

export * from '@zcorw/encrypted-vault/protocol';
export interface SessionSummary { id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string }
export interface AccountView { id: string; login: string; displayName: string; status: 'active' | 'disabled' }

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
/** A quotation's speaker is distinct from the record author (ownerId) and any evaluated person. */
export interface ReflectionQuote { text: string; kind: 'verbatim' | 'paraphrase'; speakerPersonId?: string; speakerName?: string; sourceInteractionId?: string }
export interface ReflectionContent { title?: string; type: 'feeling' | 'hypothesis' | 'experience'; content: string; context?: string; evidence?: string; counterEvidence?: string; certainty?: string; recordedOn?: PartialDate; recordedAt?: string; status: 'current' | 'revised' | 'withdrawn'; supersedesId?: string; tagIds?: string[]; quote?: ReflectionQuote }
/** Legacy reflections remain explicitly about one person; they are never reclassified from their text. */
export interface PersonReflection extends EntityBase, ReflectionContent { kind: 'reflection'; personId: string }
export interface Topic extends EntityBase { kind: 'topic'; name: string; description?: string }
export interface TopicThought extends EntityBase, ReflectionContent { kind: 'thought'; topicId: string; title: string }
/** Omitted targetKind is the legacy person reflection relation. */
export interface ReflectionInteraction extends EntityBase { kind: 'reflectionLink'; reflectionId: string; targetKind?: 'reflection' | 'thought'; interactionId: string; relationType: 'arose' | 'supports' | 'contradicts' | 'revises'; explanation?: string }
export interface FollowUp extends EntityBase { kind: 'followUp'; title: string; personIds: string[]; type: 'promise' | 'plan'; responsibility: 'me' | 'other' | 'joint'; sourceInteractionId?: string; details?: string; dueDate?: PartialDate; dueAt?: string; timezone?: string; status: 'pending' | 'completed' | 'cancelled'; completedAt?: string }
export interface Tag extends EntityBase { kind: 'tag'; name: string; color?: string }
export interface PersonTag extends EntityBase { kind: 'personTag'; personId: string; tagId: string }
export type Entity = Person | DirectoryEntry | ContactMethod | PersonFact | Interaction | PersonReflection | Topic | TopicThought | ReflectionInteraction | FollowUp | Tag | PersonTag;
