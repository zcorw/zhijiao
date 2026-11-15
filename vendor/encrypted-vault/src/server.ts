import { createHash } from 'node:crypto';
import { z } from 'zod';
import { opaqueId, decimal, operationSchema, type CipherEnvelope, type OperationResult, type ChangePage, type VaultDescriptor } from './protocol.js';
import { keyBundleSchema } from './crypto.js';
import type { VaultRepository, VaultReader, VaultTransaction, VaultChange } from './repository.js';
export type { VaultRepository, VaultReader, VaultTransaction, VaultRow, VaultChange, OperationReceipt, RecordLane } from './repository.js';
export { keyBundleSchema } from './crypto.js';
export interface VaultPrincipal { id:string }
export interface VaultServiceOptions<P extends VaultPrincipal,Tx extends VaultTransaction> {
  /** Host authentication runs inside the same transaction before vault writes. */
  authorizeWrite(transaction:Tx,principal:P):Promise<void>;
}
export class VaultError extends Error {
  constructor(readonly status:number,readonly body:{code:string;[key:string]:unknown}){super(body.code);}
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new VaultError(400,{ code: 'INVALID_PAYLOAD' }); return result.data;
}
export class VaultService<P extends VaultPrincipal = VaultPrincipal,Tx extends VaultTransaction = VaultTransaction> {
  constructor(private readonly repository:VaultRepository<Tx>,private readonly options:VaultServiceOptions<P,Tx>){
    if(typeof options.authorizeWrite!=='function')throw new Error('AUTHORIZE_WRITE_REQUIRED');
  }
  private async owned(id:string,ownerId:string,reader:VaultReader=this.repository){
    parse(opaqueId,id);const row=await reader.getVault(id,ownerId);
    if(!row)throw new VaultError(404,{code:'VAULT_NOT_FOUND'});return row;
  }
  private async locked(id:string,ownerId:string,transaction:Tx){
    parse(opaqueId,id);const row=await transaction.lockVault(id,ownerId);
    if(!row)throw new VaultError(404,{code:'VAULT_NOT_FOUND'});return row;
  }
  list(ownerId:string):Promise<VaultDescriptor[]>{return this.repository.listVaults(ownerId);}
  async get(id:string,ownerId:string){
    const {cursor:_cursor,...vault}=await this.owned(id,ownerId);
    return {...vault,keyBundleHistory:await this.repository.keyBundles(id)};
  }
  async create(principal: P, value: unknown): Promise<VaultDescriptor> {
    const input = parse(z.strictObject({ id: opaqueId, keyBundle: keyBundleSchema }), value);
    if (input.id !== input.keyBundle.vaultId) throw new VaultError(400,{ code: 'VAULT_MISMATCH' });
    return this.repository.transaction(async transaction => {
      await this.options.authorizeWrite(transaction, principal);
      const descriptor={id:input.id,ownerId:principal.id,keyBundle:input.keyBundle,keyBundleRevision:'1'};
      if(!await transaction.createVault(descriptor))throw new VaultError(409,{code:'VAULT_EXISTS'});
      return descriptor;
    });
  }
  async bundles(id:string,ownerId:string):Promise<unknown[]>{await this.owned(id,ownerId);return this.repository.keyBundles(id);}
  async rewrap(id: string, principal: P, value: unknown): Promise<VaultDescriptor> {
    const input = parse(z.strictObject({ expectedRevision: decimal, keyBundle: keyBundleSchema }), value);
    if (id !== input.keyBundle.vaultId) throw new VaultError(400,{ code: 'VAULT_MISMATCH' });
    return this.repository.transaction(async transaction => {
      await this.options.authorizeWrite(transaction, principal); const current = await this.locked(id, principal.id, transaction);
      if (current.keyBundleRevision !== input.expectedRevision) throw new VaultError(409,{ code: 'KEY_BUNDLE_CONFLICT', current: current.keyBundle });
      const oldBundle=parse(keyBundleSchema,current.keyBundle);
      if (input.keyBundle.keyVersion < oldBundle.keyVersion || input.keyBundle.keyVersion > oldBundle.keyVersion + 1)
        throw new VaultError(400,{ code: 'INVALID_KEY_VERSION' });
      const needed = await transaction.keyVersions(id);
      const included = new Set([input.keyBundle.keyVersion, ...(input.keyBundle.previousKeys ?? []).map(key => key.keyVersion)]);
      if (needed.some(version => !included.has(version))) throw new VaultError(400,{ code: 'MISSING_PREVIOUS_KEY' });
      const revision = (BigInt(input.expectedRevision) + 1n).toString(); parse(decimal, revision);
      await transaction.updateKeyBundle(id,revision,input.keyBundle);
      return { id, ownerId: principal.id, keyBundle: input.keyBundle, keyBundleRevision: revision };
    });
  }
  async operate(id: string, principal: P, value: unknown): Promise<OperationResult> {
    const operation = parse(operationSchema, value); const ids = new Set<string>(); let bytes = 0;
    for (const { expectedRevision, envelope: e } of operation.mutations) {
      const data = Buffer.from(e.ciphertext, 'base64'); bytes += data.length;
      if (ids.has(e.recordId) || e.vaultId !== id || BigInt(e.revision) !== BigInt(expectedRevision) + 1n || data.length < 16 || data.toString('base64') !== e.ciphertext ||
        (e.lane === 'assets' ? !e.variant : Boolean(e.variant))) throw new VaultError(400,{ code: 'INVALID_MUTATION' });
      ids.add(e.recordId);
    }
    if (bytes > 12000000) throw new VaultError(400,{ code: 'OPERATION_TOO_LARGE' });
    const hash = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    return this.repository.transaction(async transaction => {
      await this.options.authorizeWrite(transaction, principal); const vault = await this.locked(id, principal.id, transaction);
      const prior = await transaction.getOperation(id,operation.operationId);
      if (prior) { if (prior.requestHash !== hash) throw new VaultError(409,{ code: 'OPERATION_MISMATCH' }); return prior.result; }
      const bundle=parse(keyBundleSchema,vault.keyBundle);
      if (operation.mutations.some(m => m.envelope.keyVersion !== bundle.keyVersion))
        throw new VaultError(409,{ code: 'KEY_VERSION_CONFLICT', keyVersion: bundle.keyVersion, keyBundleRevision: vault.keyBundleRevision });
      const current=new Map((await transaction.current(id,[...ids])).map(e=>[e.recordId,e]));
      const conflicts = operation.mutations.filter(m => (current.get(m.envelope.recordId)?.revision ?? '0') !== m.expectedRevision);
      if (conflicts.length) throw new VaultError(409,{ code: 'REVISION_CONFLICT', current: conflicts.map(m => current.get(m.envelope.recordId)).filter(Boolean) });
      let cursor = BigInt(vault.cursor);const changes:VaultChange[]=[];
      for (const { envelope: e } of operation.mutations) {
        const previous = current.get(e.recordId);
        if (previous && (previous.lane !== e.lane || previous.variant !== e.variant)) throw new VaultError(400,{ code: 'ROUTE_MISMATCH' });
        cursor += 1n; parse(decimal, cursor.toString());
        changes.push({envelope:e,cursor:cursor.toString()});
      }
      await transaction.appendVersions(id,changes,cursor.toString());
      const result: OperationResult = { operationId: operation.operationId, envelopes: operation.mutations.map(m => m.envelope), cursor: cursor.toString() };
      await transaction.saveOperation(id,operation.operationId,{requestHash:hash,result});return result;
    });
  }
  async changes(id: string, ownerId: string, query: Record<string, unknown>): Promise<ChangePage> {
    const input = parse(z.strictObject({ lane: z.enum(['directory', 'records']), after: decimal.default('0'), until: decimal.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), query);
    const vault = await this.owned(id, ownerId); const until = input.until ?? vault.cursor;
    if (BigInt(input.after) > BigInt(until) || BigInt(until) > BigInt(vault.cursor)) throw new VaultError(400,{ code: 'INVALID_CURSOR' });
    const rows=await this.repository.changes(id,input.lane,input.after,until,input.limit+1);
    const hasMore=rows.length>input.limit,page=rows.slice(0,input.limit);
    return {envelopes:page.map(v=>v.envelope),after:hasMore?page[page.length-1]!.cursor:until,highWatermark:until,hasMore};
  }
  async history(id: string, ownerId: string, recordId: string): Promise<CipherEnvelope[]> {
    await this.owned(id, ownerId); parse(opaqueId, recordId);
    return this.repository.history(id,recordId);
  }
  async assets(id:string,ownerId:string){await this.owned(id,ownerId);return this.repository.assets(id);}
  async asset(id: string, ownerId: string, recordId: string, revision: unknown): Promise<CipherEnvelope> {
    await this.owned(id, ownerId); parse(opaqueId, recordId); const version = parse(decimal, revision);
    const row=await this.repository.asset(id,recordId,version);
    if (!row) throw new VaultError(404,{ code: 'ASSET_NOT_FOUND' }); return row;
  }
}
