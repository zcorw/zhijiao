import type { CipherEnvelope, VaultDescriptor } from './protocol.js';

/** The encrypted payload belongs to the host application. */
export interface VaultRecord { id: string; ownerId: string; kind: string; updatedAt?: string }
export interface RecordAdapter<T extends VaultRecord> {
  parse(value: unknown): T;
  lane(record: T): 'directory' | 'records';
  references?(record: T): Array<{ id: string; kind: string }>;
}
export interface Lease { vaultId: string; generation: number; signal: AbortSignal }
export interface PreparedWrite<T> { entities: T[]; deleteIds: string[] }
export interface HydrationContext { vault: VaultDescriptor; current: ReadonlyMap<string, CipherEnvelope> }
