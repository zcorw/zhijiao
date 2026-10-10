import type { CipherEnvelope, Operation, VaultDescriptor } from '@zhijiao/shared';
import type { KeyBundle } from './crypto.js';

export interface PendingOperation { operation: Operation; status: 'pending' | 'conflict'; current?: CipherEnvelope[]; conflictCode?: 'REVISION_CONFLICT'|'KEY_VERSION_CONFLICT' }
export interface StoredVault {
  descriptor: VaultDescriptor; keyBundles: KeyBundle[]; envelopes: CipherEnvelope[]; outbox: PendingOperation[];
  cursors: { directory: string; records: string }; complete: { directory: boolean; records: boolean };
}
export const emptyVault = (descriptor: VaultDescriptor, bundles: KeyBundle[]): StoredVault => ({ descriptor, keyBundles: bundles, envelopes: [], outbox: [], cursors: {directory:'0',records:'0'}, complete: {directory:false,records:false} });
export interface VaultStore {
  read(id: string): Promise<StoredVault | undefined>;
  list(): Promise<VaultDescriptor[]>;
  update(id: string, mutate: (previous: StoredVault | undefined) => StoredVault, signal?: AbortSignal): Promise<void>;
}
export class IndexedDbStore implements VaultStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = 'zhijiao-encrypted-v1') {}
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve,reject) => {
      const request = indexedDB.open(this.name,1);
      request.onupgradeneeded = () => request.result.createObjectStore('vaults',{keyPath:'descriptor.id'});
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = undefined; }; resolve(request.result); };
      request.onerror = () => { this.database = undefined; reject(request.error); };
      request.onblocked = () => { this.database = undefined; reject(new Error('STORAGE_BLOCKED_CLOSE_OTHER_TABS')); };
    });
    return this.database;
  }
  async read(id: string): Promise<StoredVault | undefined> {
    const db = await this.open();
    return new Promise((resolve,reject) => { const request = db.transaction('vaults','readonly').objectStore('vaults').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async list(): Promise<VaultDescriptor[]> {
    const db = await this.open();
    return new Promise((resolve,reject) => { const request = db.transaction('vaults','readonly').objectStore('vaults').getAll(); request.onsuccess = () => resolve((request.result as StoredVault[]).map(v => v.descriptor)); request.onerror = () => reject(request.error); });
  }
  listVaults(): Promise<VaultDescriptor[]> { return this.list(); }
  async update(id: string, mutate: (previous: StoredVault | undefined) => StoredVault, signal?: AbortSignal): Promise<void> {
    const db = await this.open(); signal?.throwIfAborted();
    return new Promise((resolve,reject) => {
      const transaction = db.transaction('vaults','readwrite',{durability:'strict'});
      let error: unknown;
      const abort = () => { try { transaction.abort(); } catch { /* A completed transaction has no outstanding writes. */ } };
      signal?.addEventListener('abort',abort,{once:true});
      transaction.oncomplete = () => { signal?.removeEventListener('abort',abort); resolve(); };
      transaction.onabort = () => { signal?.removeEventListener('abort',abort); reject(error ?? signal?.reason ?? transaction.error ?? new Error('STORAGE_ABORTED')); };
      transaction.onerror = () => { error ??= transaction.error; };
      const store = transaction.objectStore('vaults'); const request = store.get(id);
      request.onsuccess = () => {
        try { signal?.throwIfAborted(); const next = mutate(request.result); if (next.descriptor.id !== id) throw new Error('VAULT_ID_MISMATCH'); store.put(next); }
        catch (e) { error = e; abort(); }
      };
    });
  }
}
/** In-memory adapter for deterministic tests; production defaults to IndexedDB. */
export class MemoryStore implements VaultStore {
  private values = new Map<string,StoredVault>();
  read(id: string): Promise<StoredVault | undefined> { return Promise.resolve(structuredClone(this.values.get(id))); }
  list(): Promise<VaultDescriptor[]> { return Promise.resolve(structuredClone(Array.from(this.values.values(),v => v.descriptor))); }
  update(id: string, mutate: (previous: StoredVault | undefined) => StoredVault, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); const next = mutate(structuredClone(this.values.get(id))); signal?.throwIfAborted();
    if (next.descriptor.id !== id) throw new Error('VAULT_ID_MISMATCH'); this.values.set(id,structuredClone(next)); return Promise.resolve();
  }
}
export const envelopeIdentity = (e: CipherEnvelope) => `${e.recordId}:${e.revision}`;
export function mergeEnvelopes(existing: CipherEnvelope[], incoming: CipherEnvelope[]): CipherEnvelope[] {
  const result = new Map(existing.map(e => [envelopeIdentity(e),e]));
  for (const e of incoming) { const previous = result.get(envelopeIdentity(e)); if (previous && JSON.stringify(previous) !== JSON.stringify(e)) throw new Error('IMMUTABLE_HISTORY_MISMATCH'); result.set(envelopeIdentity(e),e); }
  return Array.from(result.values());
}
export function currentEnvelopes(vault: StoredVault, candidates = true): Map<string,CipherEnvelope> {
  const current = new Map<string,CipherEnvelope>();
  for (const e of vault.envelopes) if (!current.has(e.recordId) || BigInt(e.revision) > BigInt(current.get(e.recordId)!.revision)) current.set(e.recordId,e);
  if (candidates) for (const pending of vault.outbox) for (const m of pending.operation.mutations) current.set(m.envelope.recordId,m.envelope);
  return current;
}
