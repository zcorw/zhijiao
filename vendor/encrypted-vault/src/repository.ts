import type { CipherEnvelope, OperationResult, VaultDescriptor } from './protocol.js';
import type { AssetVersion } from './transport.js';

/** Domain data only: SQL, table names and driver types belong to adapters. */
export interface VaultRow extends VaultDescriptor { cursor: string }
export interface VaultChange { envelope: CipherEnvelope; cursor: string }
export interface OperationReceipt { requestHash: string; result: OperationResult }
export type RecordLane = 'directory' | 'records';
export interface VaultReader {
  listVaults(ownerId: string): Promise<VaultDescriptor[]>;
  getVault(id: string, ownerId: string): Promise<VaultRow | undefined>;
  keyBundles(vaultId: string): Promise<unknown[]>;
  keyVersions(vaultId: string): Promise<number[]>;
  getOperation(vaultId: string, operationId: string): Promise<OperationReceipt | undefined>;
  current(vaultId: string, recordIds: string[]): Promise<CipherEnvelope[]>;
  changes(vaultId: string, lane: RecordLane, after: string, until: string, limit: number): Promise<VaultChange[]>;
  history(vaultId: string, recordId: string): Promise<CipherEnvelope[]>;
  assets(vaultId: string): Promise<AssetVersion[]>;
  asset(vaultId: string, recordId: string, revision: string): Promise<CipherEnvelope | undefined>;
}
export interface VaultTransaction extends VaultReader {
  /** Serialize writes to this vault through commit/rollback, including across processes. */
  lockVault(id: string, ownerId: string): Promise<VaultRow | undefined>;
  /** Atomically reserve a unique ID; false if another transaction already created it. */
  createVault(descriptor: VaultDescriptor): Promise<boolean>;
  /** Replace the current bundle and append its immutable revision. */
  updateKeyBundle(vaultId: string, revision: string, bundle: unknown): Promise<void>;
  /** Append immutable versions, current pointers, change log and the vault cursor. */
  appendVersions(vaultId: string, changes: VaultChange[], cursor: string): Promise<void>;
  saveOperation(vaultId: string, operationId: string, receipt: OperationReceipt): Promise<void>;
}
export interface VaultRepository<Tx extends VaultTransaction = VaultTransaction> extends VaultReader {
  /** Commit all callback writes together; errors roll everything back. No dirty reads. */
  transaction<T>(work: (transaction: Tx) => Promise<T>): Promise<T>;
}
