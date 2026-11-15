import type { CipherEnvelope, VaultDescriptor } from '../protocol.js';
import type { OperationReceipt, RecordLane, VaultChange, VaultReader, VaultRepository, VaultRow, VaultTransaction } from '../repository.js';
import type { AssetVersion } from '../transport.js';

interface State {
  vaults: Map<string, VaultRow>;
  bundles: Map<string, unknown[]>;
  versions: Map<string, VaultChange[]>;
  operations: Map<string, Map<string, OperationReceipt>>;
}
const emptyState = (): State => ({ vaults: new Map(), bundles: new Map(), versions: new Map(), operations: new Map() });
const clone = <T>(value: T): T => structuredClone(value);
class MemoryVaultReader implements VaultReader {
  constructor(protected readonly snapshot: () => State) {}
  async listVaults(ownerId: string): Promise<VaultDescriptor[]> {
    return clone([...this.snapshot().vaults.values()].filter(v => v.ownerId === ownerId).map(({ cursor: _cursor, ...descriptor }) => descriptor));
  }
  async getVault(id: string, ownerId: string): Promise<VaultRow | undefined> {
    const vault = this.snapshot().vaults.get(id); return vault?.ownerId === ownerId ? clone(vault) : undefined;
  }
  async keyBundles(vaultId: string): Promise<unknown[]> { return clone(this.snapshot().bundles.get(vaultId) ?? []); }
  async keyVersions(vaultId: string): Promise<number[]> { return [...new Set((this.snapshot().versions.get(vaultId) ?? []).map(v => v.envelope.keyVersion))]; }
  async getOperation(vaultId: string, operationId: string): Promise<OperationReceipt | undefined> { return clone(this.snapshot().operations.get(vaultId)?.get(operationId)); }
  async current(vaultId: string, recordIds: string[]): Promise<CipherEnvelope[]> {
    const selected = new Set(recordIds), current = new Map<string, CipherEnvelope>();
    for (const { envelope } of this.snapshot().versions.get(vaultId) ?? []) {
      if (selected.has(envelope.recordId) && BigInt(envelope.revision) > BigInt(current.get(envelope.recordId)?.revision ?? '0')) current.set(envelope.recordId, envelope);
    }
    return clone([...current.values()]);
  }
  async changes(vaultId: string, lane: RecordLane, after: string, until: string, limit: number): Promise<VaultChange[]> {
    return clone((this.snapshot().versions.get(vaultId) ?? []).filter(v => v.envelope.lane === lane && BigInt(v.cursor) > BigInt(after) && BigInt(v.cursor) <= BigInt(until)).slice(0, limit));
  }
  async history(vaultId: string, recordId: string): Promise<CipherEnvelope[]> {
    return clone((this.snapshot().versions.get(vaultId) ?? []).map(v => v.envelope).filter(e => e.recordId === recordId && e.lane !== 'assets').sort((a, b) => BigInt(a.revision) < BigInt(b.revision) ? -1 : 1));
  }
  async assets(vaultId: string): Promise<AssetVersion[]> {
    return (this.snapshot().versions.get(vaultId) ?? []).filter(v => v.envelope.lane === 'assets').map(({ envelope: e }) => ({ recordId: e.recordId, revision: e.revision, variant: e.variant }));
  }
  async asset(vaultId: string, recordId: string, revision: string): Promise<CipherEnvelope | undefined> {
    return clone((this.snapshot().versions.get(vaultId) ?? []).find(v => v.envelope.lane === 'assets' && v.envelope.recordId === recordId && v.envelope.revision === revision)?.envelope);
  }
}
export class MemoryVaultTransaction extends MemoryVaultReader implements VaultTransaction {
  private active = true;
  constructor(private readonly state: State) { super(() => { if (!this.active) throw new Error('TRANSACTION_CLOSED'); return state; }); }
  close(): void { this.active = false; }
  lockVault(id: string, ownerId: string): Promise<VaultRow | undefined> { return this.getVault(id, ownerId); }
  async createVault(descriptor: VaultDescriptor): Promise<boolean> {
    this.snapshot(); if (this.state.vaults.has(descriptor.id)) return false;
    this.state.vaults.set(descriptor.id, clone({ ...descriptor, cursor: '0' }));
    this.state.bundles.set(descriptor.id, [clone(descriptor.keyBundle)]); return true;
  }
  async updateKeyBundle(vaultId: string, revision: string, bundle: unknown): Promise<void> {
    this.snapshot(); const vault = this.state.vaults.get(vaultId); if (!vault) throw new Error('VAULT_MISSING');
    this.state.vaults.set(vaultId, { ...vault, keyBundle: clone(bundle), keyBundleRevision: revision });
    this.state.bundles.set(vaultId, [...this.state.bundles.get(vaultId) ?? [], clone(bundle)]);
  }
  async appendVersions(vaultId: string, changes: VaultChange[], cursor: string): Promise<void> {
    this.snapshot(); const vault = this.state.vaults.get(vaultId); if (!vault) throw new Error('VAULT_MISSING');
    const versions = this.state.versions.get(vaultId) ?? [], identities = new Set(versions.map(v => `${v.envelope.recordId}:${v.envelope.revision}`));
    let previous = BigInt(vault.cursor);
    for (const change of changes) {
      const identity = `${change.envelope.recordId}:${change.envelope.revision}`;
      if (change.envelope.vaultId !== vaultId || identities.has(identity) || BigInt(change.cursor) !== previous + 1n) throw new Error('IMMUTABLE_HISTORY_MISMATCH');
      identities.add(identity); previous = BigInt(change.cursor);
    }
    if (previous.toString() !== cursor) throw new Error('CURSOR_MISMATCH');
    this.state.versions.set(vaultId, [...versions, ...clone(changes)]); this.state.vaults.set(vaultId, { ...vault, cursor });
  }
  async saveOperation(vaultId: string, operationId: string, receipt: OperationReceipt): Promise<void> {
    this.snapshot(); const operations = this.state.operations.get(vaultId) ?? new Map<string, OperationReceipt>();
    if (operations.has(operationId)) throw new Error('DUPLICATE_OPERATION');
    operations.set(operationId, clone(receipt)); this.state.operations.set(vaultId, operations);
  }
}
/** Nonpersistent reference adapter. A mutex serializes transactions within this instance. */
export class MemoryVaultRepository extends MemoryVaultReader implements VaultRepository<MemoryVaultTransaction> {
  private state = emptyState();
  private serial: Promise<unknown> = Promise.resolve();
  constructor() { super(() => this.state); }
  transaction<T>(work: (transaction: MemoryVaultTransaction) => Promise<T>): Promise<T> {
    const pending = this.serial.then(async () => {
      const draft = clone(this.state), transaction = new MemoryVaultTransaction(draft);
      try { const result = await work(transaction); this.state = draft; return result; }
      finally { transaction.close(); }
    });
    this.serial = pending.catch(() => {}); return pending;
  }
}
