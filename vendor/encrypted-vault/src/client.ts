import { z } from 'zod';
import { decimal, envelopeSchema, operationSchema, opaqueId, type ChangePage, type CipherEnvelope, type Operation, type VaultDescriptor } from './protocol.js';
import { createKeyBundle, decryptEnvelope, encryptEnvelope, keyBundleSchema, rewrapKeyBundle, unwrapKeyBundle, unwrapPreviousKeys, type KeyBundle } from './crypto.js';
import { ApiError, type VaultTransport } from './transport.js';
import { currentEnvelopes, emptyVault, mergeEnvelopes, type StoredVault, type VaultStore } from './storage.js';
import { exportEncryptedBackup, previewEncryptedBackup, getPreviewData, type BackupPreview } from './backup.js';
import type { VaultRecord, RecordAdapter, Lease, PreparedWrite } from './adapter.js';

export interface ClientState { locked:boolean;vaultId?:string;directoryComplete:boolean;recordsComplete:boolean;pending:number;conflicts:number;syncing:boolean;rotating:boolean;offlineMode:boolean;lastError?:string }
export interface ClientOptions<T extends VaultRecord> {adapter:RecordAdapter<T>;transport:VaultTransport;store:VaultStore;ownerId?:string;autoSync?:boolean}
export interface HistoryEntry<T extends VaultRecord = VaultRecord> {revision:string;tombstone:boolean;entity?:T}
export interface ConflictView<T extends VaultRecord = VaultRecord> {operationId:string;code:'REVISION_CONFLICT'|'KEY_VERSION_CONFLICT';local:Array<T | {id:string;deleted:true}>;remote:Array<T | {id:string;deleted:true}>}
const pageSchema=z.strictObject({envelopes:z.array(envelopeSchema).max(1000),after:decimal,highWatermark:decimal,hasMore:z.boolean()});
const descriptorSchema=z.object({id:opaqueId,ownerId:opaqueId,keyBundle:keyBundleSchema,keyBundleRevision:decimal,keyBundleHistory:z.array(keyBundleSchema).optional()});
export class VaultClient<T extends VaultRecord> {
  readonly store:VaultStore;
  protected descriptor?:VaultDescriptor;
  protected stored?:StoredVault;
  protected plain=new Map<string,T>();
  protected keys=new Map<number,{raw:Uint8Array;key:CryptoKey}>();
  protected generation=0;
  protected abort=new AbortController();
  protected unlocked=false;
  protected listeners=new Set<(state:ClientState)=>void>();
  protected stateValue:ClientState={locked:true,directoryComplete:false,recordsComplete:false,pending:0,conflicts:0,syncing:false,rotating:false,offlineMode:false};
  protected serial:Promise<unknown>=Promise.resolve();
  protected syncPromise?:Promise<void>;
  constructor(protected readonly options:ClientOptions<T>) {
    if(!options.store)throw new Error('VAULT_STORE_REQUIRED');this.store=options.store;
  }
  get state():ClientState{return {...this.stateValue};}
  get vault():VaultDescriptor|undefined{return this.descriptor?structuredClone(this.descriptor):undefined;}
  get entities():T[]{return this.unlocked?structuredClone([...this.plain.values()].filter(e=>this.options.adapter.lane(e)!=='directory')):[];}
  get directoryEntries():T[]{return this.unlocked?structuredClone([...this.plain.values()].filter(e=>this.options.adapter.lane(e)==='directory')):[];}
  subscribe(listener:(state:ClientState)=>void):()=>void{this.listeners.add(listener);listener(this.state);return()=>this.listeners.delete(listener);}
  protected emit(patch:Partial<ClientState>={}):void{
    this.stateValue={...this.stateValue,...patch,locked:!this.unlocked,vaultId:this.descriptor?.id,pending:this.stored?.outbox.filter(o=>o.status==='pending').length??0,conflicts:this.stored?.outbox.filter(o=>o.status==='conflict').length??0};
    for(const listener of this.listeners)listener(this.state);
  }
  protected check(generation:number):void{if(generation!==this.generation || this.abort.signal.aborted)throw new Error('VAULT_LOCKED_OPERATION_CANCELLED');}
  protected lease(requireUnlocked=true):{vaultId:string;generation:number;signal:AbortSignal}{
    if(!this.descriptor || (requireUnlocked&&!this.unlocked))throw new Error('VAULT_LOCKED');
    return {vaultId:this.descriptor.id,generation:this.generation,signal:this.abort.signal};
  }
  protected key(version:number):CryptoKey{const value=this.keys.get(version);if(!value || !this.unlocked)throw new Error('KEY_VERSION_UNAVAILABLE');return value.key;}
  protected queue<T>(work:()=>Promise<T>):Promise<T>{const pending=this.serial.then(work,work);this.serial=pending.catch(()=>{});return pending;}
  protected parseDescriptor(value:unknown):VaultDescriptor {
    const descriptor=descriptorSchema.parse(value);
    if(descriptor.keyBundle.vaultId!==descriptor.id || (this.options.ownerId && this.options.ownerId!==descriptor.ownerId))throw new Error('VAULT_OWNERSHIP_MISMATCH');
    return descriptor;
  }
  listLocalVaults():Promise<VaultDescriptor[]>{return this.store.list();}
  async openCached(vaultId:string):Promise<VaultDescriptor>{
    opaqueId.parse(vaultId);this.lock();this.descriptor=undefined;this.stored=undefined;const generation=this.generation;
    const cached=await this.store.read(vaultId);this.check(generation);if(!cached)throw new Error('LOCAL_VAULT_MISSING');
    this.descriptor=this.parseDescriptor(cached.descriptor);this.stored=cached;
    this.emit({directoryComplete:false,recordsComplete:false,offlineMode:true});return structuredClone(this.descriptor);
  }
  async resumeOnline():Promise<void>{
    const lease=this.lease(false);const descriptor=this.parseDescriptor(await this.options.transport.get(lease.vaultId,lease.signal));this.check(lease.generation);
    if(descriptor.id!==lease.vaultId)throw new Error('VAULT_ID_MISMATCH');this.emit({offlineMode:false});if(this.unlocked)await this.sync();
  }
  async open(vaultId:string):Promise<VaultDescriptor>{
    opaqueId.parse(vaultId);this.lock();this.descriptor=undefined;this.stored=undefined;this.emit({directoryComplete:false,recordsComplete:false,lastError:undefined});
    const generation=this.generation,signal=this.abort.signal;const cached=await this.store.read(vaultId);this.check(generation);
    let descriptor:VaultDescriptor,offlineMode=false;
    try{descriptor=this.parseDescriptor(await this.options.transport.get(vaultId,signal));}
    catch(error){this.check(generation);if(error instanceof ApiError || !cached)throw error;descriptor=this.parseDescriptor(cached.descriptor);offlineMode=true;}
    this.check(generation);
    await this.store.update(vaultId,old=>({...old??emptyVault(descriptor,[]),descriptor,keyBundles:this.mergeBundles(old?.keyBundles??[],[keyBundleSchema.parse(descriptor.keyBundle)])}),signal);
    this.check(generation);this.descriptor=descriptor;this.stored=await this.store.read(vaultId);this.check(generation);this.emit({offlineMode});return structuredClone(descriptor);
  }
  async setup(passphrase:string):Promise<{vault:VaultDescriptor;recoverySecret:string}>{
    this.lock();this.descriptor=undefined;this.stored=undefined;
    const generation=this.generation,signal=this.abort.signal,id=crypto.randomUUID();
    const created=await createKeyBundle(id,passphrase);
    try{
      this.check(generation);const descriptor=this.parseDescriptor(await this.options.transport.create(id,created.bundle,signal));this.check(generation);
      await this.store.update(id,old=>{if(old)throw new Error('VAULT_ALREADY_EXISTS');return emptyVault(descriptor,[created.bundle]);},signal);this.check(generation);
      this.descriptor=descriptor;this.stored=await this.store.read(id);this.check(generation);this.keys.set(created.bundle.keyVersion,{raw:created.raw,key:created.key});this.unlocked=true;
      await this.hydrate(generation);this.check(generation);
      this.emit({directoryComplete:false,recordsComplete:false,lastError:undefined,offlineMode:false});this.scheduleSync();return {vault:structuredClone(descriptor),recoverySecret:created.recoverySecret};
    }catch(error){created.raw.fill(0);if(generation===this.generation&&this.unlocked)this.lock();throw error;}
  }
  async unlock(secret:string,options:{recovery?:boolean}={}):Promise<void>{
    const lease=this.lease(false);if(this.unlocked)throw new Error('VAULT_ALREADY_UNLOCKED');
    const opened=await unwrapKeyBundle(this.descriptor!.keyBundle,secret,options.recovery);
    let previous=new Map<number,{raw:Uint8Array;key:CryptoKey}>();
    try{
      this.check(lease.generation);if(opened.bundle.vaultId!==lease.vaultId)throw new Error('KEY_BUNDLE_VAULT_MISMATCH');
      const stored=await this.store.read(lease.vaultId);this.check(lease.generation);if(!stored)throw new Error('LOCAL_VAULT_MISSING');
      previous=await unwrapPreviousKeys(opened.bundle,opened.key);this.check(lease.generation);
      for(const [version,key] of previous)this.keys.set(version,key);this.keys.set(opened.bundle.keyVersion,{raw:opened.raw,key:opened.key});this.unlocked=true;this.stored=stored;
      await this.hydrate(lease.generation);this.check(lease.generation);this.emit({directoryComplete:stored.complete.directory,recordsComplete:stored.complete.records,lastError:undefined});this.scheduleSync();
    }catch(error){opened.raw.fill(0);for(const key of previous.values())key.raw.fill(0);if(lease.generation===this.generation)this.lock();throw error;}
  }
  lock():void{
    this.generation++;this.abort.abort(new Error('VAULT_LOCKED_OPERATION_CANCELLED'));this.abort=new AbortController();this.unlocked=false;
    for(const key of this.keys.values())key.raw.fill(0);this.keys.clear();this.plain.clear();this.onLock();this.syncPromise=undefined;
    this.emit({syncing:false,rotating:false,lastError:undefined});
  }
  protected mergeBundles(previous:KeyBundle[],next:KeyBundle[]):KeyBundle[]{
    const result=new Map(previous.map(v=>[JSON.stringify(v),v]));for(const bundle of next){keyBundleSchema.parse(bundle);if(bundle.vaultId!==this.descriptor?.id && this.descriptor)throw new Error('KEY_BUNDLE_VAULT_MISMATCH');result.set(JSON.stringify(bundle),bundle);}return [...result.values()];
  }
  protected validateRouting(entity:T,envelope:CipherEnvelope):void{
    if(entity.id!==envelope.recordId || entity.ownerId!==this.descriptor?.ownerId || envelope.vaultId!==this.descriptor.id || this.options.adapter.lane(entity)!==envelope.lane)throw new Error('ENTITY_ROUTING_MISMATCH');
  }
  protected async decode(envelope:CipherEnvelope):Promise<T|undefined>{
    if(envelope.vaultId!==this.descriptor?.id || envelope.lane==='assets')throw new Error('ENTITY_ROUTING_MISMATCH');
    const value=await decryptEnvelope(this.key(envelope.keyVersion),envelope);
    if(envelope.tombstone){const tombstone=z.strictObject({id:opaqueId,kind:z.literal('deleted'),previousKind:z.string().min(1)}).parse(value);if(tombstone.id!==envelope.recordId)throw new Error('TOMBSTONE_ROUTING_MISMATCH');return undefined;}
    const entity=this.options.adapter.parse(value);this.validateRouting(entity,envelope);return entity;
  }
  protected async hydrate(generation:number):Promise<void>{
    this.check(generation);const result=new Map<string,T>(),current=currentEnvelopes(this.stored!);
    for(const envelope of current.values()){
      if(envelope.lane==='assets')continue;
      const entity=await this.decode(envelope);this.check(generation);if(entity)result.set(entity.id,entity);
    }
    await this.hydrateRecords(result,current,generation);
    this.check(generation);this.plain=result;
  }
  protected onLock():void {}
  protected hydrateRecords(_records:Map<string,T>,_current:Map<string,CipherEnvelope>,_generation:number):Promise<void>{return Promise.resolve();}
  put(entity:T):Promise<Operation>{return this.saveBatch([entity]);}
  saveBatch(entities:T[]):Promise<Operation>{const lease=this.lease();return this.queue(()=>this.write(entities,[],[],lease));}
  mutateBatch(entities:T[],deleteIds:string[]):Promise<Operation>{
    const lease=this.lease();return this.queue(async()=>{
      this.check(lease.generation);
      for(const id of deleteIds){opaqueId.parse(id);if(!this.plain.has(id))throw new Error('ENTITY_NOT_FOUND');}
      return this.write(entities,deleteIds,[],lease);
    });
  }
  delete(id:string):Promise<Operation>{return this.mutateBatch([],[id]);}
  protected async write(inputs:T[],deleteIds:string[],extra:CipherEnvelope[],lease:Lease):Promise<Operation>{
    this.check(lease.generation);const stored=await this.store.read(lease.vaultId);this.check(lease.generation);if(!stored)throw new Error('LOCAL_VAULT_MISSING');
    const current=currentEnvelopes(stored);
    const prepared=await this.prepareWrite(inputs,deleteIds,current);
    const entities=prepared.entities.map(value=>this.options.adapter.parse(value));
    const expandedDeletes=new Set(prepared.deleteIds);
    if(new Set([...entities.map(e=>e.id),...expandedDeletes]).size!==entities.length+expandedDeletes.size || expandedDeletes.size!==prepared.deleteIds.length)throw new Error('DUPLICATE_MUTATION');
    for(const entity of entities){opaqueId.parse(entity.id);if(entity.ownerId!==this.descriptor!.ownerId)throw new Error('ENTITY_OWNER_MISMATCH');}
    this.check(lease.generation);const mutations:Operation['mutations']=[];const keyVersion=keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion;
    for(const e of entities){
      const existing=current.get(e.id);if(existing?.tombstone)throw new Error('EXPLICIT_RESTORE_REQUIRED');
      if(existing&&(this.options.adapter.lane(e)!==existing.lane || (this.plain.get(e.id)&&this.plain.get(e.id)!.kind!==e.kind)))throw new Error('ENTITY_KIND_IMMUTABLE');
      const expectedRevision=existing?.revision??'0',revision=(BigInt(expectedRevision)+1n).toString();
      const envelope=await encryptEnvelope(this.key(keyVersion),{vaultId:lease.vaultId,recordId:e.id,revision,keyVersion,formatVersion:1,lane:this.options.adapter.lane(e),tombstone:false},e);this.check(lease.generation);mutations.push({expectedRevision,envelope});
    }
    for(const id of expandedDeletes){const existing=current.get(id);if(!existing || existing.tombstone)continue;
      const envelope=await encryptEnvelope(this.key(keyVersion),{...existing,revision:(BigInt(existing.revision)+1n).toString(),keyVersion,tombstone:true},{id,kind:'deleted',previousKind:this.plain.get(id)?.kind??'record'});this.check(lease.generation);mutations.push({expectedRevision:existing.revision,envelope});}
    for(const envelope of extra)mutations.push({expectedRevision:current.get(envelope.recordId)?.revision??'0',envelope});
    const operation=operationSchema.parse({operationId:crypto.randomUUID(),mutations});
    // compare in the same transaction: another tab cannot silently replace our expected versions.
    await this.store.update(lease.vaultId,old=>{
      this.check(lease.generation);if(!old)throw new Error('LOCAL_VAULT_MISSING');const latest=currentEnvelopes(old);
      for(const mutation of operation.mutations){if((latest.get(mutation.envelope.recordId)?.revision??'0')!==mutation.expectedRevision)throw new Error('LOCAL_REVISION_CONFLICT');if(old.outbox.some(o=>o.status==='conflict'&&o.operation.mutations.some(m=>m.envelope.recordId===mutation.envelope.recordId)))throw new Error('UNRESOLVED_CONFLICT');}
      return {...old,outbox:[...old.outbox,{operation,status:'pending'}]};
    },lease.signal);
    this.check(lease.generation);this.stored=await this.store.read(lease.vaultId);this.check(lease.generation);await this.hydrate(lease.generation);this.emit({lastError:undefined});this.scheduleSync();return operation;
  }
  protected async prepareWrite(inputs:T[],deleteIds:string[],_current:Map<string,CipherEnvelope>):Promise<PreparedWrite<T>>{
    const entities=inputs.map(value=>this.options.adapter.parse(value));
    const known=new Map(this.plain);for(const e of entities)known.set(e.id,e);
    for(const entity of entities)for(const ref of this.options.adapter.references?.(entity)??[]){
      if(known.get(ref.id)?.kind!==ref.kind)throw new Error('REFERENCE_NOT_FOUND');
      if(deleteIds.includes(ref.id))throw new Error('REFERENCE_TO_DELETED_ENTITY');
    }
    return {entities,deleteIds};
  }
  protected scheduleSync():void{if(this.options.autoSync!==false&&!this.stateValue.offlineMode)void this.sync().catch(()=>{});}
  sync():Promise<void>{
    const lease=this.lease();if(this.stateValue.offlineMode)return Promise.reject(new Error('OFFLINE_MODE_SIGN_IN_REQUIRED'));if(this.syncPromise)return this.syncPromise;
    const pending=this.queue(()=>this.runSync(lease));this.syncPromise=pending;
    void pending.finally(()=>{if(this.syncPromise===pending)this.syncPromise=undefined;}).catch(()=>{});return pending;
  }
  protected async runSync(lease:Lease):Promise<void>{
    this.check(lease.generation);this.emit({syncing:true,lastError:undefined});
    try{
      // Refresh wrappers without replacing an unlocked data key; revoked account sessions fail here.
      const descriptor=this.parseDescriptor(await this.options.transport.get(lease.vaultId,lease.signal));this.check(lease.generation);
      const bundles=(await this.options.transport.keyBundles(lease.vaultId,lease.signal)).map(v=>keyBundleSchema.parse(v));this.check(lease.generation);
      if(bundles.some(b=>b.vaultId!==lease.vaultId))throw new Error('KEY_BUNDLE_VAULT_MISMATCH');
      await this.store.update(lease.vaultId,old=>({...old!,descriptor,keyBundles:this.mergeBundles(old!.keyBundles,bundles)}),lease.signal);this.check(lease.generation);this.descriptor=descriptor;
      if(!this.keys.has(keyBundleSchema.parse(descriptor.keyBundle).keyVersion))throw new Error('KEY_ROTATED_REUNLOCK_REQUIRED');
      // Download a complete directory snapshot before any heavyweight business history.
      await this.downloadLane('directory',lease);
      await this.downloadLane('records',lease);
      await this.flush(lease);
      await this.downloadLane('directory',lease);await this.downloadLane('records',lease);
      this.check(lease.generation);this.emit({lastError:undefined});
    }catch(error){if(lease.generation===this.generation)this.emit({lastError:error instanceof Error?error.message:'SYNC_FAILED'});throw error;}
    finally{if(lease.generation===this.generation)this.emit({syncing:false});}
  }
  protected async downloadLane(lane:'directory'|'records',lease:Lease):Promise<void>{
    let stored=await this.store.read(lease.vaultId);this.check(lease.generation);let after=stored!.cursors[lane],until:string|undefined;
    for(;;){
      const page:ChangePage=pageSchema.parse(await this.options.transport.changes(lease.vaultId,lane,after,until,lease.signal));this.check(lease.generation);
      if(BigInt(page.after)<BigInt(after) || BigInt(page.after)>BigInt(page.highWatermark) || (until!==undefined&&page.highWatermark!==until) || (page.hasMore&&page.after===after))throw new Error('INVALID_SYNC_CURSOR');
      until??=page.highWatermark;
      for(const envelope of page.envelopes){if(envelope.vaultId!==lease.vaultId || envelope.lane!==lane)throw new Error('SYNC_ROUTING_MISMATCH');await this.decode(envelope);this.check(lease.generation);}
      await this.store.update(lease.vaultId,old=>{if(old!.cursors[lane]!==after)throw new Error('LOCAL_CURSOR_CHANGED');return {...old!,envelopes:mergeEnvelopes(old!.envelopes,page.envelopes),cursors:{...old!.cursors,[lane]:page.after},complete:{...old!.complete,[lane]:!page.hasMore}};},lease.signal);
      this.check(lease.generation);stored=await this.store.read(lease.vaultId);this.check(lease.generation);this.stored=stored;await this.hydrate(lease.generation);this.emit({directoryComplete:stored!.complete.directory,recordsComplete:stored!.complete.records});after=page.after;
      if(!page.hasMore){if(after!==until)throw new Error('INCOMPLETE_SYNC_SNAPSHOT');break;}
    }
  }
  protected async flush(lease:Lease):Promise<void>{
    for(;;){
      const stored=await this.store.read(lease.vaultId);this.check(lease.generation);const first=stored!.outbox[0];if(!first || first.status==='conflict')break;
      try{
        const result=await this.options.transport.commit(lease.vaultId,first.operation,lease.signal);this.check(lease.generation);
        const acknowledged=z.array(envelopeSchema).max(100).parse(result.envelopes);
        if(result.operationId!==first.operation.operationId || JSON.stringify(acknowledged)!==JSON.stringify(first.operation.mutations.map(m=>m.envelope)))throw new Error('OPERATION_ACK_MISMATCH');
        decimal.parse(result.cursor);
        await this.store.update(lease.vaultId,old=>({...old!,envelopes:mergeEnvelopes(old!.envelopes,result.envelopes),outbox:old!.outbox.filter(o=>o.operation.operationId!==first.operation.operationId)}),lease.signal);
      }catch(error){
        this.check(lease.generation);
        if(error instanceof ApiError && error.code==='REVISION_CONFLICT'){
          const remote=z.array(envelopeSchema).max(100).parse(error.body.current??[]);
          const ids=new Set(first.operation.mutations.map(m=>m.envelope.recordId));for(const e of remote){if(e.vaultId!==lease.vaultId || !ids.has(e.recordId))throw new Error('CONFLICT_ROUTING_MISMATCH');if(e.lane!=='assets')await this.decode(e);this.check(lease.generation);}
          await this.store.update(lease.vaultId,old=>({...old!,envelopes:mergeEnvelopes(old!.envelopes,remote),outbox:old!.outbox.map(o=>o.operation.operationId===first.operation.operationId?{...o,status:'conflict',current:remote,conflictCode:'REVISION_CONFLICT'}:o)}),lease.signal);break;
        }
        if(error instanceof ApiError && error.code==='KEY_VERSION_CONFLICT'){
          // The original candidate is retained. A newly unlocked device must explicitly choose how to reapply it.
          const confirmed=currentEnvelopes(stored!,false),remote=first.operation.mutations.map(m=>confirmed.get(m.envelope.recordId)).filter((e):e is CipherEnvelope=>!!e);
          await this.store.update(lease.vaultId,old=>({...old!,outbox:old!.outbox.map(o=>o.operation.operationId===first.operation.operationId?{...o,status:'conflict',current:remote,conflictCode:'KEY_VERSION_CONFLICT'}:o)}),lease.signal);break;
        }
        throw error;
      }
    }
    this.check(lease.generation);this.stored=await this.store.read(lease.vaultId);this.check(lease.generation);await this.hydrate(lease.generation);this.emit();
  }
  async conflicts():Promise<ConflictView<T>[]>{
    const lease=this.lease(),result:ConflictView<T>[]=[];
    for(const pending of this.stored!.outbox.filter(o=>o.status==='conflict')){
      const local:ConflictView<T>['local']=[],remote:ConflictView<T>['remote']=[];
      for(const e of pending.operation.mutations.map(m=>m.envelope)){if(e.lane==='assets')continue;const entity=await this.decode(e);this.check(lease.generation);local.push(entity??{id:e.recordId,deleted:true});}
      for(const e of pending.current??[]){if(e.lane==='assets')continue;const entity=await this.decode(e);this.check(lease.generation);remote.push(entity??{id:e.recordId,deleted:true});}
      result.push({operationId:pending.operation.operationId,code:pending.conflictCode??'REVISION_CONFLICT',local,remote});
    }
    return result;
  }
  /** Explicit remote choice discards dependent local operations. Export backup first to retain candidates. */
  discardConflict(operationId:string):Promise<void>{
    const lease=this.lease();return this.queue(async()=>{
      await this.store.update(lease.vaultId,old=>{
        const conflict=old!.outbox.find(o=>o.operation.operationId===operationId&&o.status==='conflict');if(!conflict)throw new Error('CONFLICT_NOT_FOUND');
        const affected=new Set(conflict.operation.mutations.map(m=>m.envelope.recordId));const outbox=old!.outbox.filter(o=>{if(o.operation.mutations.some(m=>affected.has(m.envelope.recordId))){for(const m of o.operation.mutations)affected.add(m.envelope.recordId);return false;}return true;});return {...old!,outbox};
      },lease.signal);this.check(lease.generation);this.stored=await this.store.read(lease.vaultId);await this.hydrate(lease.generation);this.emit();this.scheduleSync();
    });
  }
  /** Local deleted-record candidates only; history coverage is exposed separately in state.recordsComplete. */
  async deletedEntities():Promise<T[]>{
    const lease=this.lease();const stored=await this.store.read(lease.vaultId);this.check(lease.generation);
    if(!stored)throw new Error('LOCAL_VAULT_MISSING');
    const deleted=new Map([...currentEnvelopes(stored)].filter(([,envelope])=>envelope.lane==='records'&&envelope.tombstone));
    const previous=new Map<string,CipherEnvelope>();
    const history=[...stored.envelopes,...stored.outbox.flatMap(item=>item.operation.mutations.map(mutation=>mutation.envelope))];
    for(const envelope of history){
      const tombstone=deleted.get(envelope.recordId);
      if(!tombstone || envelope.lane!=='records' || envelope.tombstone || BigInt(envelope.revision)>=BigInt(tombstone.revision))continue;
      const latest=previous.get(envelope.recordId);
      if(!latest || BigInt(envelope.revision)>BigInt(latest.revision))previous.set(envelope.recordId,envelope);
    }
    const result:T[]=[];
    for(const [id,tombstone] of deleted){
      this.check(lease.generation);if(tombstone.vaultId!==lease.vaultId)throw new Error('TOMBSTONE_ROUTING_MISMATCH');
      await this.decode(tombstone);this.check(lease.generation);
      const envelope=previous.get(id);if(!envelope)continue;
      const entity=await this.decode(envelope);this.check(lease.generation);if(entity)result.push(entity);
    }
    this.check(lease.generation);return result;
  }
  async history(id:string):Promise<HistoryEntry<T>[]>{
    opaqueId.parse(id);const lease=this.lease();let envelopes=this.stored!.envelopes.filter(e=>e.recordId===id);
    try{
      const remote=z.array(envelopeSchema).max(100_000).parse(await this.options.transport.history(lease.vaultId,id,lease.signal));this.check(lease.generation);
      if(remote.some(e=>e.vaultId!==lease.vaultId || e.recordId!==id || e.lane==='assets'))throw new Error('HISTORY_ROUTING_MISMATCH');
      for(const envelope of remote){await this.decode(envelope);this.check(lease.generation);}
      envelopes=mergeEnvelopes(envelopes,remote);await this.store.update(lease.vaultId,old=>({...old!,envelopes:mergeEnvelopes(old!.envelopes,remote)}),lease.signal);this.check(lease.generation);
    }catch(error){this.check(lease.generation);if(error instanceof ApiError || envelopes.length===0)throw error;}
    const result:HistoryEntry<T>[]=[];for(const envelope of envelopes.sort((a,b)=>BigInt(a.revision)<BigInt(b.revision)?-1:1)){const entity=await this.decode(envelope);this.check(lease.generation);result.push({revision:envelope.revision,tombstone:envelope.tombstone,entity});}return result;
  }
  restore(id:string,revision:string):Promise<Operation>{
    opaqueId.parse(id);decimal.parse(revision);const lease=this.lease();return this.queue(async()=>{
      const versions=await this.history(id);this.check(lease.generation);const old=versions.find(e=>e.revision===revision);if(!old?.entity)throw new Error('RESTORE_VERSION_NOT_FOUND');
      const current=currentEnvelopes(this.stored!).get(id);if(!current)throw new Error('ENTITY_NOT_FOUND');
      // A restore is a new authenticated revision; an old ciphertext is never replayed.
      return this.restoreWrite(old.entity,lease);
    });
  }
  protected async restoreWrite(entity:T,lease:Lease):Promise<Operation>{
    const stored=await this.store.read(lease.vaultId);this.check(lease.generation);const current=currentEnvelopes(stored!),keyVersion=keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion;
    const entities=await this.prepareRestore(entity,keyVersion,lease);
    const mutations:Operation['mutations']=[];for(const e of entities){const expectedRevision=current.get(e.id)?.revision??'0';const envelope=await encryptEnvelope(this.key(keyVersion),{vaultId:lease.vaultId,recordId:e.id,revision:(BigInt(expectedRevision)+1n).toString(),keyVersion,formatVersion:1,lane:this.options.adapter.lane(e),tombstone:false},e);this.check(lease.generation);mutations.push({expectedRevision,envelope});}
    const operation=operationSchema.parse({operationId:crypto.randomUUID(),mutations});
    await this.store.update(lease.vaultId,old=>{const latest=currentEnvelopes(old!);for(const m of mutations){if((latest.get(m.envelope.recordId)?.revision??'0')!==m.expectedRevision)throw new Error('LOCAL_REVISION_CONFLICT');if(old!.outbox.some(o=>o.status==='conflict'&&o.operation.mutations.some(v=>v.envelope.recordId===m.envelope.recordId)))throw new Error('UNRESOLVED_CONFLICT');}return {...old!,outbox:[...old!.outbox,{operation,status:'pending'}]};},lease.signal);
    this.check(lease.generation);this.stored=await this.store.read(lease.vaultId);await this.hydrate(lease.generation);this.emit();this.scheduleSync();return operation;
  }
  protected async prepareRestore(entity:T,_keyVersion:number,_lease:Lease):Promise<T[]>{
    const restored=this.options.adapter.parse({...entity,...(entity.updatedAt===undefined?{}:{updatedAt:new Date().toISOString()})});
    return (await this.prepareWrite([restored],[],currentEnvelopes(this.stored!))).entities;
  }
  protected rotateRecord(entity:T,_version:number,_lease:Lease):Promise<T>{return Promise.resolve(entity);}
  rewrap(newPassphrase:string):Promise<void>{const lease=this.lease();return this.queue(async()=>{
    const bundle=keyBundleSchema.parse(this.descriptor!.keyBundle),raw=this.keys.get(bundle.keyVersion)!.raw;
    const rewrapped=await rewrapKeyBundle(bundle,raw,newPassphrase);this.check(lease.generation);
    const descriptor=this.parseDescriptor(await this.options.transport.rewrap(lease.vaultId,this.descriptor!.keyBundleRevision,rewrapped,lease.signal));this.check(lease.generation);
    if(JSON.stringify(descriptor.keyBundle)!==JSON.stringify(rewrapped))throw new Error('KEY_BUNDLE_ACK_MISMATCH');
    await this.store.update(lease.vaultId,old=>({...old!,descriptor,keyBundles:this.mergeBundles(old!.keyBundles,[rewrapped])}),lease.signal);this.check(lease.generation);this.descriptor=descriptor;this.stored=await this.store.read(lease.vaultId);this.emit();
  });}
  async rotateDataKey(newPassphrase:string):Promise<{recoverySecret:string;keyVersion:number;completed:boolean}>{
    const lease=this.lease();await this.sync();this.check(lease.generation);
    return this.queue(async()=>{
      this.check(lease.generation);if(this.stored!.outbox.length)throw new Error('RESOLVE_PENDING_OPERATIONS_BEFORE_ROTATION');
      const old=keyBundleSchema.parse(this.descriptor!.keyBundle),version=old.keyVersion+1;
      const created=await createKeyBundle(lease.vaultId,newPassphrase,undefined,undefined,version,new Map([...this.keys].map(([v,k])=>[v,k.raw])));this.emit({rotating:true});
      let installed=false;
      try{
        this.check(lease.generation);const descriptor=this.parseDescriptor(await this.options.transport.rewrap(lease.vaultId,this.descriptor!.keyBundleRevision,created.bundle,lease.signal));this.check(lease.generation);
        if(JSON.stringify(keyBundleSchema.parse(descriptor.keyBundle))!==JSON.stringify(created.bundle))throw new Error('KEY_BUNDLE_ACK_MISMATCH');
        await this.store.update(lease.vaultId,old=>({...old!,descriptor,keyBundles:this.mergeBundles(old!.keyBundles,[created.bundle])}),lease.signal);this.check(lease.generation);
        this.descriptor=descriptor;this.keys.set(version,{key:created.key,raw:created.raw});installed=true;this.stored=await this.store.read(lease.vaultId);this.check(lease.generation);
        try{await this.resumeRotationWrites(lease);return {recoverySecret:created.recoverySecret,keyVersion:version,completed:true};}
        catch(error){this.check(lease.generation);this.emit({lastError:error instanceof Error?error.message:'ROTATION_INTERRUPTED'});return {recoverySecret:created.recoverySecret,keyVersion:version,completed:false};}
      }finally{if(!installed)created.raw.fill(0);if(lease.generation===this.generation)this.emit({rotating:false});}
    });
  }
  async resumeRotation():Promise<void>{const lease=this.lease();await this.sync();this.check(lease.generation);return this.queue(async()=>{this.emit({rotating:true});try{await this.resumeRotationWrites(lease);}finally{if(lease.generation===this.generation)this.emit({rotating:false});}});}
  protected async resumeRotationWrites(lease:Lease):Promise<void>{
    const version=keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion;
    for(;;){
      this.check(lease.generation);const current=currentEnvelopes(this.stored!),batch:T[]=[];
      for(const entity of this.entities){if(this.options.adapter.lane(entity)==='directory')continue;const envelope=current.get(entity.id);if(!envelope || envelope.keyVersion===version)continue;
        const next=await this.rotateRecord({...entity},version,lease);batch.push(next);if(batch.length>=45)break;
      }
      if(!batch.length)break;await this.write(batch,[],[],lease);this.check(lease.generation);await this.flush(lease);
    }
    await this.downloadLane('directory',lease);await this.downloadLane('records',lease);this.emit();
  }
  protected async loadAsset(id:string,revision:string,signal:AbortSignal):Promise<CipherEnvelope>{
    const lease=this.lease();signal.throwIfAborted();const cached=this.stored!.envelopes.find(e=>e.recordId===id&&e.revision===revision&&e.lane==='assets')??this.stored!.outbox.flatMap(o=>o.operation.mutations).map(m=>m.envelope).find(e=>e.recordId===id&&e.revision===revision&&e.lane==='assets');if(cached)return cached;
    const envelope=envelopeSchema.parse(await this.options.transport.asset(lease.vaultId,id,revision,signal));this.check(lease.generation);
    if(envelope.vaultId!==lease.vaultId || envelope.recordId!==id || envelope.revision!==revision || envelope.lane!=='assets')throw new Error('ASSET_ROUTING_MISMATCH');
    await this.store.update(lease.vaultId,old=>({...old!,envelopes:mergeEnvelopes(old!.envelopes,[envelope])}),signal);this.check(lease.generation);this.stored=await this.store.read(lease.vaultId);return envelope;
  }
  async exportBackup():Promise<string>{
    const lease=this.lease();await this.sync();this.check(lease.generation);
    const assets=await this.options.transport.assets(lease.vaultId,lease.signal);this.check(lease.generation);
    if(assets.length>100_000)throw new Error('BACKUP_ASSET_LIMIT');
    for(const asset of assets){opaqueId.parse(asset.recordId);decimal.parse(asset.revision);await this.loadAsset(asset.recordId,asset.revision,lease.signal);this.check(lease.generation);}
    const stored=await this.store.read(lease.vaultId);this.check(lease.generation);
    const result=await this.exportStoredBackup(stored!,this.key(keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion),version=>this.key(version));this.check(lease.generation);return result;
  }
  protected exportStoredBackup(stored:StoredVault,key:CryptoKey,getKey:(version:number)=>CryptoKey):Promise<string>{return exportEncryptedBackup(stored,key,getKey,this.options.adapter);}
  protected previewStoredBackup(text:string,secret:string,options:{recovery?:boolean}):Promise<BackupPreview>{return previewEncryptedBackup(text,secret,this.options.adapter,options);}
  protected previewData(preview:BackupPreview):StoredVault{return getPreviewData(preview);}
  previewBackup(text:string,secret:string,options:{recovery?:boolean}={}):Promise<BackupPreview>{const generation=this.generation;return this.previewStoredBackup(text,secret,options).then(result=>{this.check(generation);return result;});}
  importBackup(preview:BackupPreview,confirmation:{confirm:true}):Promise<void>{
    if(confirmation.confirm!==true)return Promise.reject(new Error('BACKUP_CONFIRMATION_REQUIRED'));
    const generation=this.generation,signal=this.abort.signal;return this.queue(async()=>{
      const data=this.previewData(preview);this.check(generation);if(this.descriptor && this.descriptor.id!==data.descriptor.id)throw new Error('BACKUP_VAULT_MISMATCH');
      if(this.options.ownerId && this.options.ownerId!==data.descriptor.ownerId)throw new Error('BACKUP_OWNER_MISMATCH');
      // Import is local and preserves every authenticated ID/revision; never silently replace newer versions or queued work.
      await this.store.update(data.descriptor.id,old=>{
        if(old&&(old.outbox.length || old.envelopes.length))throw new Error('BACKUP_IMPORT_REQUIRES_EMPTY_LOCAL_VAULT');return structuredClone(data);
      },signal);this.check(generation);this.descriptor=data.descriptor;this.stored=await this.store.read(data.descriptor.id);this.emit({directoryComplete:false,recordsComplete:false});
    });
  }
}
