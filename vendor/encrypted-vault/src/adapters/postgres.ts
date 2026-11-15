import type { Pool, PoolClient } from 'pg';
import type { CipherEnvelope, VaultDescriptor } from '../protocol.js';
import type { VaultRepository, VaultTransaction, VaultReader, VaultRow, VaultChange, OperationReceipt, RecordLane } from '../repository.js';
import type { AssetVersion } from '../transport.js';
import { validateTablePrefix } from './postgres-schema.js';
export { vaultSchema, validateTablePrefix } from './postgres-schema.js';

const projection = `v.vault_id AS "vaultId",v.record_id AS "recordId",v.revision::text,v.key_version AS "keyVersion",v.format_version AS "formatVersion",v.lane,v.tombstone,v.variant,v.nonce,v.ciphertext`;
function envelope(row: Record<string, unknown>): CipherEnvelope {
  const { ciphertext, variant, ...rest } = row;
  return { ...rest, ...(variant ? { variant } : {}), ciphertext: (ciphertext as Buffer).toString('base64') } as CipherEnvelope;
}
class PostgresVaultReader implements VaultReader {
  constructor(protected readonly database: Pool | PoolClient, protected readonly prefix: string) {}
  async listVaults(ownerId: string): Promise<VaultDescriptor[]> {
    return (await this.database.query(`SELECT id,owner_id AS "ownerId",key_bundle AS "keyBundle",key_bundle_revision::text AS "keyBundleRevision" FROM ${this.prefix}vaults WHERE owner_id=$1 ORDER BY created_at`, [ownerId])).rows;
  }
  async getVault(id: string, ownerId: string): Promise<VaultRow | undefined> {
    return (await this.database.query(`SELECT id,owner_id AS "ownerId",key_bundle AS "keyBundle",key_bundle_revision::text AS "keyBundleRevision",cursor::text FROM ${this.prefix}vaults WHERE id=$1 AND owner_id=$2`, [id, ownerId])).rows[0];
  }
  async keyBundles(vaultId: string): Promise<unknown[]> {
    return (await this.database.query(`SELECT bundle FROM ${this.prefix}key_bundles WHERE vault_id=$1 ORDER BY revision`, [vaultId])).rows.map(row => row.bundle);
  }
  async keyVersions(vaultId: string): Promise<number[]> {
    return (await this.database.query(`SELECT DISTINCT key_version FROM ${this.prefix}versions WHERE vault_id=$1`, [vaultId])).rows.map(row => row.key_version as number);
  }
  async getOperation(vaultId: string, operationId: string): Promise<OperationReceipt | undefined> {
    return (await this.database.query(`SELECT request_hash AS "requestHash",result FROM ${this.prefix}operations WHERE vault_id=$1 AND operation_id=$2`, [vaultId, operationId])).rows[0];
  }
  async current(vaultId: string, recordIds: string[]): Promise<CipherEnvelope[]> {
    return (await this.database.query(`SELECT ${projection} FROM ${this.prefix}current c JOIN ${this.prefix}versions v USING(vault_id,record_id,revision) WHERE c.vault_id=$1 AND c.record_id=ANY($2::uuid[])`, [vaultId, recordIds])).rows.map(envelope);
  }
  async changes(vaultId: string, lane: RecordLane, after: string, until: string, limit: number): Promise<VaultChange[]> {
    const rows = (await this.database.query(`SELECT ${projection},v.cursor::text AS change_cursor FROM ${this.prefix}changelog c JOIN ${this.prefix}versions v USING(vault_id,record_id,revision) WHERE c.vault_id=$1 AND v.lane=$2 AND c.cursor>$3 AND c.cursor<=$4 ORDER BY c.cursor LIMIT $5`, [vaultId, lane, after, until, limit])).rows;
    return rows.map(({ change_cursor: cursor, ...row }) => ({ envelope: envelope(row), cursor }));
  }
  async history(vaultId: string, recordId: string): Promise<CipherEnvelope[]> {
    return (await this.database.query(`SELECT ${projection} FROM ${this.prefix}versions v WHERE vault_id=$1 AND record_id=$2 AND lane IN('records','directory') ORDER BY revision`, [vaultId, recordId])).rows.map(envelope);
  }
  async assets(vaultId: string): Promise<AssetVersion[]> {
    return (await this.database.query(`SELECT record_id AS "recordId",revision::text,variant FROM ${this.prefix}versions WHERE vault_id=$1 AND lane='assets' ORDER BY cursor`, [vaultId])).rows;
  }
  async asset(vaultId: string, recordId: string, revision: string): Promise<CipherEnvelope | undefined> {
    const row = (await this.database.query(`SELECT ${projection} FROM ${this.prefix}versions v WHERE vault_id=$1 AND record_id=$2 AND revision=$3 AND lane='assets'`, [vaultId, recordId, revision])).rows[0];
    return row ? envelope(row) : undefined;
  }
}
/** Driver handles are adapter-specific and available to host authentication code only. */
export class PostgresVaultTransaction extends PostgresVaultReader implements VaultTransaction {
  readonly client: Pick<PoolClient, 'query'>;
  private readonly lifecycle: { active: boolean };
  constructor(client: PoolClient, prefix: string) {
    const lifecycle = { active: true };
    const guarded = new Proxy(client, { get(target, property) {
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? (...args: unknown[]) => {
        if (!lifecycle.active) throw new Error('TRANSACTION_CLOSED');
        return Reflect.apply(value, target, args);
      } : value;
    } });
    super(guarded, prefix); this.client = guarded; this.lifecycle = lifecycle;
  }
  close(): void { this.lifecycle.active = false; }
  async lockVault(id: string, ownerId: string): Promise<VaultRow | undefined> {
    return (await this.client.query(`SELECT id,owner_id AS "ownerId",key_bundle AS "keyBundle",key_bundle_revision::text AS "keyBundleRevision",cursor::text FROM ${this.prefix}vaults WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [id, ownerId])).rows[0];
  }
  async createVault(descriptor: VaultDescriptor): Promise<boolean> {
    const created = await this.client.query(`INSERT INTO ${this.prefix}vaults(id,owner_id,key_bundle) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [descriptor.id, descriptor.ownerId, descriptor.keyBundle]);
    if (!created.rowCount) return false;
    await this.client.query(`INSERT INTO ${this.prefix}key_bundles(vault_id,revision,bundle) VALUES($1,$2,$3)`, [descriptor.id, descriptor.keyBundleRevision, descriptor.keyBundle]);
    return true;
  }
  async updateKeyBundle(vaultId: string, revision: string, bundle: unknown): Promise<void> {
    await this.client.query(`UPDATE ${this.prefix}vaults SET key_bundle=$2,key_bundle_revision=$3 WHERE id=$1`, [vaultId, bundle, revision]);
    await this.client.query(`INSERT INTO ${this.prefix}key_bundles(vault_id,revision,bundle) VALUES($1,$2,$3)`, [vaultId, revision, bundle]);
  }
  async appendVersions(vaultId: string, changes: VaultChange[], cursor: string): Promise<void> {
    for (const { envelope: e, cursor: changeCursor } of changes) {
      await this.client.query(`INSERT INTO ${this.prefix}versions(vault_id,record_id,revision,key_version,format_version,lane,tombstone,variant,nonce,ciphertext,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [vaultId, e.recordId, e.revision, e.keyVersion, e.formatVersion, e.lane, e.tombstone, e.variant ?? null, e.nonce, Buffer.from(e.ciphertext, 'base64'), changeCursor]);
      await this.client.query(`INSERT INTO ${this.prefix}current(vault_id,record_id,revision) VALUES($1,$2,$3) ON CONFLICT(vault_id,record_id) DO UPDATE SET revision=EXCLUDED.revision`, [vaultId, e.recordId, e.revision]);
      await this.client.query(`INSERT INTO ${this.prefix}changelog(vault_id,cursor,record_id,revision) VALUES($1,$2,$3,$4)`, [vaultId, changeCursor, e.recordId, e.revision]);
    }
    await this.client.query(`UPDATE ${this.prefix}vaults SET cursor=$2 WHERE id=$1`, [vaultId, cursor]);
  }
  async saveOperation(vaultId: string, operationId: string, receipt: OperationReceipt): Promise<void> {
    await this.client.query(`INSERT INTO ${this.prefix}operations(vault_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)`, [vaultId, operationId, receipt.requestHash, receipt.result]);
  }
}
export interface PostgresVaultRepositoryOptions { tablePrefix?: string }
export class PostgresVaultRepository extends PostgresVaultReader implements VaultRepository<PostgresVaultTransaction> {
  constructor(private readonly pool: Pool, options: PostgresVaultRepositoryOptions = {}) { super(pool, validateTablePrefix(options.tablePrefix ?? 'ev_')); }
  async transaction<T>(work: (transaction: PostgresVaultTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transaction = new PostgresVaultTransaction(client, this.prefix);
    try {
      await client.query('BEGIN');
      const result = await work(transaction);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { transaction.close(); client.release(); }
  }
}
