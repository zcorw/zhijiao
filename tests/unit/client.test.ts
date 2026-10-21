import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { deflateSync } from 'node:zlib';
import { createCipheriv } from 'node:crypto';
import { aad, type CipherEnvelope, type Interaction, type Operation, type Person, type VaultDescriptor } from '@zhijiao/shared';
import { ApiError, AvatarCache, IndexedDbStore, MemoryStore, VaultClient, avatarCropRect, base64, createKeyBundle, decryptAvatarAsset, decryptEnvelope, directoryId, emptyVault, encryptAvatarAsset, encryptBytes, encryptEnvelope, importAesKey, keyBundleSchema, planPersonDeletion, randomBytes, references, rewrapKeyBundle, unwrapKeyBundle, validateAvatarPng, validateEntity, type KeyBundle, type VaultTransport } from '../../packages/client/src/index.js';

const password='fictional vault phrase 123';
const ownerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const person=(name='林初',id=crypto.randomUUID()):Person=>({id,ownerId,kind:'person',displayName:name,aliases:['小林'],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'active',summary:'虚构读书会认识'});
class Server implements VaultTransport {
  descriptor?:VaultDescriptor;bundles:KeyBundle[]=[];all:Array<{cursor:bigint;envelope:CipherEnvelope}>=[];cursor=0n;offline=false;operations=new Map<string,{operation:Operation;result:{operationId:string;envelopes:CipherEnvelope[];cursor:string}}>();
  laneCalls:string[]=[];beforeChanges?:()=>Promise<void>;
  available(){if(this.offline)throw new Error('OFFLINE');}
  async list(){this.available();return this.descriptor?[structuredClone(this.descriptor)]:[];}
  async get(){this.available();if(!this.descriptor)throw new Error('NOT_FOUND');return structuredClone(this.descriptor);}
  async create(id:string,bundle:KeyBundle){this.available();this.bundles=[bundle];this.descriptor={id,ownerId,keyBundle:bundle,keyBundleRevision:'1'};return this.get();}
  async keyBundles(){this.available();return structuredClone(this.bundles);}
  async rewrap(_id:string,expectedRevision:string,bundle:KeyBundle){this.available();if(this.descriptor!.keyBundleRevision!==expectedRevision)throw new ApiError(409,{code:'REVISION_CONFLICT'});keyBundleSchema.parse(bundle);this.bundles.push(bundle);this.descriptor={...this.descriptor!,keyBundle:bundle,keyBundleRevision:(BigInt(expectedRevision)+1n).toString()};return this.get();}
  async commit(_id:string,operation:Operation){
    this.available();const previous=this.operations.get(operation.operationId);
    if(previous){if(JSON.stringify(previous.operation)!==JSON.stringify(operation))throw new ApiError(409,{code:'OPERATION_MISMATCH'});return structuredClone(previous.result);}
    const keyVersion=keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion;if(operation.mutations.some(m=>m.envelope.keyVersion!==keyVersion))throw new ApiError(409,{code:'KEY_VERSION_CONFLICT'});
    const current=new Map<string,CipherEnvelope>();for(const e of this.all)current.set(e.envelope.recordId,e.envelope);
    if(operation.mutations.some(m=>(current.get(m.envelope.recordId)?.revision??'0')!==m.expectedRevision))throw new ApiError(409,{code:'REVISION_CONFLICT',current:operation.mutations.map(m=>current.get(m.envelope.recordId)).filter((e):e is CipherEnvelope=>!!e)});
    this.cursor++;const envelopes=operation.mutations.map(m=>structuredClone(m.envelope));for(const envelope of envelopes)this.all.push({cursor:this.cursor,envelope});
    const result={operationId:operation.operationId,envelopes,cursor:this.cursor.toString()};this.operations.set(operation.operationId,{operation:structuredClone(operation),result});return structuredClone(result);
  }
  async changes(_id:string,lane:'directory'|'records',after:string,until?:string){
    this.available();this.laneCalls.push(lane);await this.beforeChanges?.();const watermark=until??this.cursor.toString();
    return {envelopes:structuredClone(this.all.filter(e=>e.cursor>BigInt(after)&&e.cursor<=BigInt(watermark)&&e.envelope.lane===lane).map(e=>e.envelope)),after:watermark,highWatermark:watermark,hasMore:false};
  }
  async history(_id:string,recordId:string){this.available();return structuredClone(this.all.filter(e=>e.envelope.recordId===recordId).map(e=>e.envelope));}
  async assets(){this.available();return this.all.filter(e=>e.envelope.lane==='assets').map(e=>({recordId:e.envelope.recordId,revision:e.envelope.revision,variant:e.envelope.variant}));}
  async asset(_id:string,recordId:string,revision:string){this.available();return structuredClone(this.all.find(e=>e.envelope.recordId===recordId&&e.envelope.revision===revision)!.envelope);}
}
const clients:VaultClient[]=[];
async function client(server=new Server(),store=new MemoryStore()) {const engine=new VaultClient({transport:server,store,ownerId,autoSync:false});clients.push(engine);const setup=await engine.setup(password);await engine.sync();return {engine,server,store,setup};}
async function device(server:Server,store=new MemoryStore()) {const engine=new VaultClient({transport:server,store,ownerId,autoSync:false});clients.push(engine);await engine.open(server.descriptor!.id);await engine.unlock(password);await engine.sync();return {engine,store};}
function crc(bytes:Uint8Array){let c=0xffffffff;for(const b of bytes){c^=b;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type:string,data:Uint8Array){const encoded=new TextEncoder().encode(type),buffer=new Uint8Array(data.length+12),view=new DataView(buffer.buffer);view.setUint32(0,data.length);buffer.set(encoded,4);buffer.set(data,8);view.setUint32(data.length+8,crc(buffer.subarray(4,data.length+8)));return buffer;}
function png(size:number,metadata=false){const header=new Uint8Array(13);new DataView(header.buffer).setUint32(0,size);new DataView(header.buffer).setUint32(4,size);header[8]=8;header[9]=6;const row=new Uint8Array(size*4+1);const raster=new Uint8Array(row.length*size);for(let y=0;y<size;y++)raster.set(row,y*row.length);const chunks=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(metadata?[chunk('tEXt',new TextEncoder().encode('GPS\0fictional'))]:[]),chunk('IDAT',deflateSync(raster)),chunk('IEND',new Uint8Array())];const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;}
afterEach(()=>{vi.restoreAllMocks();for(const engine of clients.splice(0))engine.lock();});

describe('client cryptographic boundary',()=>{
  it('matches AES-256-GCM implementation including 128-bit tag and authenticated data',async()=>{
    const raw=randomBytes(32),key=await importAesKey(raw),plain=new TextEncoder().encode('fictional text'),authenticated='route:a';
    const result=await encryptBytes(key,plain,authenticated);const cipher=createCipheriv('aes-256-gcm',raw,Buffer.from(result.nonce,'base64'));cipher.setAAD(Buffer.from(authenticated));
    const expected=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]).toString('base64');expect(result.ciphertext).toBe(expected);expect(result.nonce).toHaveLength(16);raw.fill(0);
  });
  it('rejects tampering and changing record, vault, revision or lane',async()=>{
    const key=await importAesKey(randomBytes(32)),vaultId=crypto.randomUUID(),entity=person();
    const envelope=await encryptEnvelope(key,{vaultId,recordId:entity.id,revision:'1',keyVersion:1,formatVersion:1,lane:'records',tombstone:false},entity);
    expect(await decryptEnvelope(key,envelope)).toEqual(entity);
    for(const patch of [{recordId:crypto.randomUUID()},{vaultId:crypto.randomUUID()},{revision:'2'},{lane:'directory' as const},{tombstone:true},{keyVersion:2},{ciphertext:(envelope.ciphertext[0]==='A'?'B':'A')+envelope.ciphertext.slice(1)}])await expect(decryptEnvelope(key,{...envelope,...patch})).rejects.toThrow();
    expect(aad(envelope)).toContain(entity.id);
  });
  it('uses distinct random nonces and independent recovery secret, and rewrap preserves data key',async()=>{
    const created=await createKeyBundle(crypto.randomUUID(),password),recovered=await unwrapKeyBundle(created.bundle,created.recoverySecret,true);expect(base64(recovered.raw)).toBe(base64(created.raw));
    const next=await rewrapKeyBundle(created.bundle,created.raw,'another fictional vault phrase');await expect(unwrapKeyBundle(next,password)).rejects.toThrow();
    const opened=await unwrapKeyBundle(next,'another fictional vault phrase'),stillRecovered=await unwrapKeyBundle(next,created.recoverySecret,true);expect(base64(opened.raw)).toBe(base64(created.raw));expect(base64(stillRecovered.raw)).toBe(base64(created.raw));
    const nonces=new Set<string>();for(let i=0;i<50;i++)nonces.add((await encryptBytes(created.key,new Uint8Array([i]),'test')).nonce);expect(nonces.size).toBe(50);
    for(const item of [created,recovered,opened,stillRecovered])item.raw.fill(0);
  });
  it('bounds KDF parameters before expensive derivation and rejects noncanonical base64',async()=>{
    const created=await createKeyBundle(crypto.randomUUID(),password);
    for(const iterations of [0,599999,2000001,Number.MAX_SAFE_INTEGER])await expect(unwrapKeyBundle({...created.bundle,kdf:{...created.bundle.kdf,iterations}},password)).rejects.toThrow();
    expect(keyBundleSchema.safeParse({...created.bundle,kdf:{...created.bundle.kdf,salt:'A'.repeat(24)}}).success).toBe(false);
    await expect(unwrapKeyBundle({...created.bundle,vaultId:crypto.randomUUID()},password)).rejects.toThrow();created.raw.fill(0);
  });
});
describe('encrypted storage and sync',()=>{
  it('accepts complete interactions without participants while retaining participant and task validation',()=>{
    const entry:Interaction={id:crypto.randomUUID(),ownerId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),kind:'interaction',title:'Fictional quiet afternoon',participantIds:[],content:'Fictional feeling recorded without a person.'};
    expect(validateEntity(entry)).toEqual(entry);expect(references(entry)).toEqual([]);
    const personId=crypto.randomUUID();expect(references({...entry,participantIds:[personId]})).toEqual([{id:personId,kind:'person'}]);
    for(const participantIds of [undefined,['invalid-id'],[personId,personId],Array.from({length:1001},()=>crypto.randomUUID())])expect(()=>validateEntity({...entry,participantIds})).toThrow();
    expect(()=>validateEntity({id:crypto.randomUUID(),ownerId,createdAt:entry.createdAt,updatedAt:entry.updatedAt,kind:'followUp',title:'Fictional task',personIds:[],type:'plan',responsibility:'me',status:'pending'})).toThrow();
  });
  it('persists unassociated interactions across IndexedDB reload, edit, association changes, sync, history and backup',async()=>{
    Object.assign(globalThis,{indexedDB});const databaseName=`test-optional-participants-${crypto.randomUUID()}`,store=new IndexedDbStore(databaseName),server=new Server();
    const initial=new VaultClient({transport:server,store,ownerId,autoSync:false});clients.push(initial);await initial.setup(password);await initial.sync();const vaultId=initial.vault!.id;
    const now=new Date().toISOString(),entry:Interaction={id:crypto.randomUUID(),ownerId,createdAt:now,updatedAt:now,kind:'interaction',title:'Fictional train encounter',participantIds:[],occurredOn:'2026-10-12',content:'A fictional event worth keeping without creating a person.'};
    server.offline=true;await initial.put(entry);expect(initial.entities).toEqual([entry]);expect(initial.directoryEntries).toEqual([]);expect(initial.state.pending).toBe(1);
    const persisted=JSON.stringify(await store.read(vaultId));expect(persisted).not.toContain(entry.title);expect(persisted).not.toContain(entry.content);initial.lock();
    const reloadedStore=new IndexedDbStore(databaseName),reloaded=new VaultClient({transport:server,store:reloadedStore,ownerId,autoSync:false});clients.push(reloaded);await reloaded.openCached(vaultId);await reloaded.unlock(password);expect(reloaded.entities).toEqual([entry]);
    const edited={...entry,title:'Fictional train reflection',content:'A fictional revised feeling.',occurredOn:'2026-10-13',updatedAt:new Date().toISOString()};await reloaded.put(edited);expect(reloaded.state.pending).toBe(2);server.offline=false;await reloaded.resumeOnline();expect(reloaded.state.pending).toBe(0);
    const originalCiphertext=structuredClone(server.all.find(item=>item.envelope.recordId===entry.id)!.envelope),friend=person('Fictional friend'),existing:Interaction={...entry,id:crypto.randomUUID(),title:'Fictional linked conversation',participantIds:[friend.id]};await reloaded.saveBatch([friend,existing]);await reloaded.sync();
    const associated={...edited,participantIds:[friend.id],updatedAt:new Date().toISOString()};await reloaded.put(associated);await reloaded.sync();expect((reloaded.entities.find(entity=>entity.id===entry.id) as Interaction).participantIds).toEqual([friend.id]);
    const detached={...associated,participantIds:[],updatedAt:new Date().toISOString()};await reloaded.put(detached);await reloaded.sync();expect(reloaded.entities.find(entity=>entity.id===entry.id)).toEqual(detached);expect(reloaded.entities.find(entity=>entity.id===existing.id)).toEqual(existing);expect(reloaded.directoryEntries.map(entity=>entity.personId)).toEqual([friend.id]);
    expect(server.all.find(item=>item.envelope.recordId===entry.id)!.envelope).toEqual(originalCiphertext);const history=await reloaded.history(entry.id);expect(history.map(version=>version.revision)).toEqual(['1','2','3','4']);expect(history.every(version=>!version.tombstone)).toBe(true);expect(history.map(version=>(version.entity as Interaction).participantIds)).toEqual([[],[],[friend.id],[]]);expect(history[0]!.entity).toEqual(entry);
    const {engine:other}=await device(server);expect(other.entities.find(entity=>entity.id===entry.id)).toEqual(detached);expect(other.entities.find(entity=>entity.id===existing.id)).toEqual(existing);
    await other.restore(entry.id,'3');await other.sync();expect((other.entities.find(entity=>entity.id===entry.id) as Interaction).participantIds).toEqual([friend.id]);await other.restore(entry.id,'4');await other.sync();expect((other.entities.find(entity=>entity.id===entry.id) as Interaction).participantIds).toEqual([]);expect((await other.history(entry.id)).map(version=>version.revision)).toEqual(['1','2','3','4','5','6']);
    const backup=await other.exportBackup();expect(backup).not.toContain(detached.content);const restored=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(restored);const preview=await restored.previewBackup(backup,password);expect(preview.people).toBe(1);await restored.importBackup(preview,{confirm:true});await restored.unlock(password);expect((restored.entities.find(entity=>entity.id===entry.id) as Interaction).participantIds).toEqual([]);expect(restored.entities.find(entity=>entity.id===existing.id)).toEqual(existing);
  });
  it('saves ciphertext and outbox atomically, derives directory and supports aliases/pinyin/initials',async()=>{
    const {engine,store,server}=await client();const entry=person();await engine.put(entry);const stored=await store.read(engine.vault!.id);expect(stored!.outbox).toHaveLength(1);expect(stored!.outbox[0]!.operation.mutations).toHaveLength(2);expect(JSON.stringify(stored)).not.toContain(entry.displayName);
    expect(engine.searchPeople('linchu').entries[0]!.personId).toBe(entry.id);expect(engine.searchPeople('lc').entries[0]!.personId).toBe(entry.id);expect(engine.searchPeople('小林').entries[0]!.personId).toBe(entry.id);
    server.laneCalls=[];await engine.sync();expect(server.laneCalls.slice(0,2)).toEqual(['directory','records']);expect(engine.state.pending).toBe(0);expect(engine.state.directoryComplete).toBe(true);expect(engine.state.recordsComplete).toBe(true);
  });
  it('does not claim an incomplete directory is a complete search',async()=>{
    const server=new Server(),engine=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(engine);await engine.setup(password);expect(engine.searchPeople('missing')).toEqual({entries:[],complete:false});
    await engine.sync();expect(engine.searchPeople('missing').complete).toBe(true);
  });
  it('indexes full legal name without altering person aliases and can search archived names explicitly',async()=>{
    const {engine}=await client();const entry={...person('小许'),fullName:'许宁',aliases:['阿宁']};await engine.put(entry);expect(engine.searchPeople('xuning').entries[0]!.personId).toBe(entry.id);expect(engine.searchPeople('xn').entries[0]!.personId).toBe(entry.id);expect((engine.entities[0] as Person).aliases).toEqual(['阿宁']);
    await engine.put({...entry,status:'archived'});expect(engine.searchPeople('许宁').entries).toHaveLength(0);expect(engine.searchPeople('xn',{includeArchived:true}).entries[0]!.personId).toBe(entry.id);
  });
  it('persists two offline revisions and retries a lost acknowledgement idempotently',async()=>{
    const {engine,server}=await client();const entry=person();server.offline=true;await engine.put(entry);await engine.put({...entry,displayName:'林初改名'});await expect(engine.sync()).rejects.toThrow('OFFLINE');expect(engine.state.pending).toBe(2);
    server.offline=false;const original=server.commit.bind(server);let first=true;server.commit=async(id,op)=>{const result=await original(id,op);if(first){first=false;throw new Error('NETWORK_LOST_AFTER_COMMIT');}return result;};
    await expect(engine.sync()).rejects.toThrow('NETWORK_LOST_AFTER_COMMIT');expect(engine.state.pending).toBe(2);await engine.sync();expect(engine.state.pending).toBe(0);expect(server.operations.size).toBe(2);expect(engine.entities[0]!.kind==='person'&&engine.entities[0].displayName).toBe('林初改名');
  });
  it('preserves both conflict candidates, never revives a tombstone, and requires explicit restore',async()=>{
    const {engine:a,server}=await client();const entry=person();await a.put(entry);await a.sync();const {engine:b}=await device(server);await a.put({...entry,displayName:'远端修订'});await b.put({...entry,displayName:'本机离线修订'});await a.sync();await b.sync();
    expect(b.state.conflicts).toBe(1);const conflicts=await b.conflicts();expect(conflicts[0]!.local.some(e=>'displayName'in e&&e.displayName==='本机离线修订')).toBe(true);expect(conflicts[0]!.remote.some(e=>'displayName'in e&&e.displayName==='远端修订')).toBe(true);
    await b.discardConflict(conflicts[0]!.operationId);expect(b.entities[0]!.kind==='person'&&b.entities[0].displayName).toBe('远端修订');await a.delete(entry.id);await a.sync();await b.sync();expect(b.entities).toHaveLength(0);await expect(b.put(entry)).rejects.toThrow('EXPLICIT_RESTORE_REQUIRED');
    await b.restore(entry.id,'1');await b.sync();expect(b.entities[0]!.kind==='person'&&b.entities[0].displayName).toBe(entry.displayName);expect((await b.history(entry.id)).map(e=>e.revision)).toEqual(['1','2','3','4']);
  });
  it('cancels late download on lock and cannot write back plaintext or advance cursor',async()=>{
    const {engine:a,server}=await client();const entry=person();await a.put(entry);await a.sync();
    const store=new MemoryStore(),b=new VaultClient({transport:server,store,ownerId,autoSync:false});clients.push(b);await b.open(a.vault!.id);await b.unlock(password);
    let resolve!:()=>void,started!:()=>void;const waiting=new Promise<void>(r=>{resolve=r;});const called=new Promise<void>(r=>{started=r;});server.beforeChanges=()=>{started();return waiting;};
    const syncing=b.sync();await called;b.lock();resolve();await expect(syncing).rejects.toThrow('VAULT_LOCKED_OPERATION_CANCELLED');expect(b.entities).toHaveLength(0);expect(b.directoryEntries).toHaveLength(0);expect((await store.read(a.vault!.id))!.cursors.directory).toBe('0');
  });
  it('retains other participants and supports batch interaction/reflection/event links',async()=>{
    const {engine}=await client();const a=person(),b=person('许宁');const interaction={id:crypto.randomUUID(),ownerId,createdAt:a.createdAt,updatedAt:a.updatedAt,kind:'interaction' as const,title:'虚构聚餐',participantIds:[a.id,b.id],content:'虚构示例'};const reflection={id:crypto.randomUUID(),ownerId,createdAt:a.createdAt,updatedAt:a.updatedAt,kind:'reflection' as const,personId:a.id,type:'feeling' as const,content:'愿意倾听',status:'current' as const};const link={id:crypto.randomUUID(),ownerId,createdAt:a.createdAt,updatedAt:a.updatedAt,kind:'reflectionLink' as const,reflectionId:reflection.id,interactionId:interaction.id,relationType:'arose' as const};
    await engine.saveBatch([a,b,interaction,reflection,link]);await engine.sync();await engine.delete(a.id);await engine.sync();const remaining=engine.entities.find(e=>e.id===interaction.id);expect(remaining?.kind==='interaction'&&remaining.participantIds).toEqual([b.id]);expect(engine.entities.some(e=>e.id===b.id)).toBe(true);expect(engine.entities.some(e=>e.id===reflection.id || e.id===link.id)).toBe(false);
    expect(planPersonDeletion(a.id,[a,b,interaction]).updates).toHaveLength(1);
  });
  it('rolls back failed IndexedDB mutations and aborted transactions',async()=>{
    Object.assign(globalThis,{indexedDB});const store=new IndexedDbStore(`test-${crypto.randomUUID()}`),bundle=await createKeyBundle(crypto.randomUUID(),password),descriptor={id:bundle.bundle.vaultId,ownerId,keyBundle:bundle.bundle,keyBundleRevision:'1'};
    await store.update(descriptor.id,()=>emptyVault(descriptor,[bundle.bundle]));await expect(store.update(descriptor.id,old=>{old!.cursors.directory='9';throw new Error('ROLLBACK');})).rejects.toThrow('ROLLBACK');expect((await store.read(descriptor.id))!.cursors.directory).toBe('0');
    const controller=new AbortController();controller.abort();await expect(store.update(descriptor.id,old=>({...old!,cursors:{directory:'99',records:'0'}}),controller.signal)).rejects.toThrow();expect((await store.read(descriptor.id))!.cursors.directory).toBe('0');expect((await store.listVaults())[0]!.id).toBe(descriptor.id);bundle.raw.fill(0);
  });
  it('supports cached unlock without uploading until online identity is verified',async()=>{
    const {engine,server,store}=await client();const entry=person();await engine.put(entry);await engine.sync();engine.lock();
    await engine.openCached(server.descriptor!.id);await engine.unlock(password);expect(engine.state.offlineMode).toBe(true);await engine.put({...entry,displayName:'离线修订'});await expect(engine.sync()).rejects.toThrow('OFFLINE_MODE_SIGN_IN_REQUIRED');expect((await store.read(server.descriptor!.id))!.outbox).toHaveLength(1);
    await engine.resumeOnline();expect(engine.state.offlineMode).toBe(false);expect(engine.state.pending).toBe(0);
  });
  it('refuses to restore dangling participant and reflection references until dependencies are restored',async()=>{
    const {engine}=await client();const a=person(),b=person('虚构友人');const interaction={id:crypto.randomUUID(),ownerId,createdAt:a.createdAt,updatedAt:a.updatedAt,kind:'interaction' as const,title:'仅标题',participantIds:[a.id,b.id],content:''};await engine.saveBatch([a,b,interaction]);await engine.sync();await engine.delete(a.id);await engine.sync();
    await expect(engine.restore(interaction.id,'1')).rejects.toThrow('REFERENCE_NOT_FOUND_RESTORE_DEPENDENCIES_FIRST');await engine.restore(a.id,'1');await engine.sync();await engine.restore(interaction.id,'1');await engine.sync();expect((engine.entities.find(e=>e.id===interaction.id) as typeof interaction).participantIds).toEqual([a.id,b.id]);
  });
  it('atomically deletes all participants and dependent records without creating empty interactions or tasks',async()=>{
    const {engine}=await client();const a=person(),b=person('虚构友人');const base={ownerId,createdAt:a.createdAt,updatedAt:a.updatedAt};const interaction={...base,id:crypto.randomUUID(),kind:'interaction' as const,title:'虚构多人',participantIds:[a.id,b.id],content:''},task={...base,id:crypto.randomUUID(),kind:'followUp' as const,title:'虚构事项',personIds:[a.id,b.id],type:'plan' as const,responsibility:'joint' as const,status:'pending' as const};await engine.saveBatch([a,b,interaction,task]);await engine.sync();await engine.mutateBatch([],[a.id,b.id]);await engine.sync();expect(engine.entities).toHaveLength(0);expect((await engine.history(task.id)).at(-1)!.tombstone).toBe(true);
  });
  it('lists the latest pre-deletion business version locally without directory duplicates or plaintext persistence',async()=>{
    const {engine,store,server}=await client();const entry=person(),living=person('仍在记录的虚构友人');await engine.saveBatch([entry,living]);await engine.sync();await engine.put({...entry,displayName:'删除前最后称呼'});await engine.sync();await engine.delete(entry.id);
    server.offline=true;const before=JSON.stringify(await store.read(engine.vault!.id)),deleted=await engine.deletedEntities();expect(deleted).toHaveLength(1);expect(deleted[0]!.kind==='person'&&deleted[0].displayName).toBe('删除前最后称呼');expect(deleted[0]!.id).toBe(entry.id);expect(deleted.some(e=>e.kind==='directory')).toBe(false);expect(JSON.stringify(await store.read(engine.vault!.id))).toBe(before);expect(before).not.toContain('删除前最后称呼');
    (deleted[0] as Person).displayName='仅修改返回对象';expect((await engine.deletedEntities())[0]!.kind==='person'&&((await engine.deletedEntities())[0] as Person).displayName).toBe('删除前最后称呼');server.offline=false;await engine.sync();await engine.restore(entry.id,'2');await engine.sync();expect(await engine.deletedEntities()).toEqual([]);engine.lock();await expect(engine.deletedEntities()).rejects.toThrow('VAULT_LOCKED');
  });
  it('rejects a deleted-record lookup whose decryption finishes after locking',async()=>{
    const {engine}=await client();const entry=person();await engine.put(entry);await engine.sync();await engine.delete(entry.id);await engine.sync();
    let resume!:()=>void,started!:()=>void;const pending=new Promise<void>(resolve=>{resume=resolve;}),called=new Promise<void>(resolve=>{started=resolve;});const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle,'decrypt').mockImplementationOnce(async(...args)=>{const result=await decrypt(...args);started();await pending;return result;});
    const looking=engine.deletedEntities();await called;engine.lock();resume();await expect(looking).rejects.toThrow('VAULT_LOCKED_OPERATION_CANCELLED');expect(engine.entities).toEqual([]);
  });
});
describe('self-contained encrypted backup and assets',()=>{
  it('previews complete backup with history and both avatar sizes and restores on a clean device',async()=>{
    const {engine,server,setup}=await client();const entry=person();await engine.put(entry);await engine.sync();await engine.putAvatar(entry.id,{main:png(512),thumb:png(128)});await engine.sync();await engine.rewrap('new fictional vault phrase 456');const text=await engine.exportBackup();expect(text).not.toContain(entry.displayName);expect(text).not.toContain(setup.recoverySecret);
    const clean=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(clean);const preview=await clean.previewBackup(text,setup.recoverySecret,{recovery:true});expect(preview.assets).toBe(2);expect(preview.people).toBe(1);await clean.importBackup(preview,{confirm:true});await clean.unlock('new fictional vault phrase 456');expect(clean.entities.some(e=>e.id===entry.id)).toBe(true);await clean.sync();expect((await clean.history(entry.id))).toHaveLength(2);
    const restored=clean.entities.find(e=>e.id===entry.id) as Person;const handle=await clean.acquireAvatar(restored.avatar!);expect(handle.url.startsWith('blob:')).toBe(true);handle.release();clean.lock();expect(clean.entities).toHaveLength(0);
  });
  it('rejects manifest tampering, substituted records, excessive KDF and unvalidated import',async()=>{
    const {engine}=await client();await engine.put(person());await engine.sync();const text=await engine.exportBackup();const bundle=JSON.parse(text);bundle.envelopes[0].recordId=crypto.randomUUID();await expect(engine.previewBackup(JSON.stringify(bundle),password)).rejects.toThrow('BACKUP_MANIFEST_MISMATCH');
    const altered=JSON.parse(text);altered.vault.keyBundle.kdf.iterations=2000001;await expect(engine.previewBackup(JSON.stringify(altered),password)).rejects.toThrow();await expect(engine.importBackup({vaultId:engine.vault!.id,createdAt:new Date().toISOString(),records:0,assets:0,pending:0,people:0},{confirm:true})).rejects.toThrow('BACKUP_PREVIEW_REQUIRED');
  });
  it('rejects PNG metadata, corrupt CRC and asset/key envelope substitution',async()=>{
    expect(validateAvatarPng(png(128),128).width).toBe(128);expect(()=>validateAvatarPng(png(128,true))).toThrow('AVATAR_METADATA_OR_UNSUPPORTED_CHUNK');const corrupt=png(128);corrupt[33]^=1;expect(()=>validateAvatarPng(corrupt)).toThrow();
    const vaultId=crypto.randomUUID(),key=await importAesKey(randomBytes(32)),asset=await encryptAvatarAsset(key,vaultId,1,'thumb',png(128));expect((await decryptAvatarAsset(key,vaultId,1,asset.reference,'thumb',asset.envelope)).length).toBeGreaterThan(40);
    await expect(decryptAvatarAsset(key,vaultId,1,{...asset.reference,id:crypto.randomUUID()},'thumb',asset.envelope)).rejects.toThrow('ASSET_ROUTING_MISMATCH');await expect(decryptAvatarAsset(key,vaultId,1,asset.reference,'main',asset.envelope)).rejects.toThrow('ASSET_ROUTING_MISMATCH');
    const substituted=await encryptAvatarAsset(key,vaultId,1,'thumb',png(128));await expect(decryptAvatarAsset(key,vaultId,1,{...asset.reference,keyEnvelope:substituted.reference.keyEnvelope},'thumb',asset.envelope)).rejects.toThrow();
  });
  it('accepts centered landscape and portrait crops in short-edge units and rejects out-of-image crops',()=>{
    expect(avatarCropRect(640,320,{x:0.5,y:0,size:1})).toEqual({x:160,y:0,size:320});expect(avatarCropRect(320,640,{x:0,y:0.5,size:1})).toEqual({x:0,y:160,size:320});
    expect(avatarCropRect(640,320,{x:1,y:0,size:1})).toEqual({x:320,y:0,size:320});expect(()=>avatarCropRect(640,320,{x:1.01,y:0,size:1})).toThrow('INVALID_CROP');expect(()=>avatarCropRect(320,640,{x:0,y:1.01,size:1})).toThrow('INVALID_CROP');
    expect(()=>avatarCropRect(640,320,{x:NaN,y:0,size:1})).toThrow('INVALID_CROP');expect(()=>avatarCropRect(640,320,{x:0,y:0,size:1.1})).toThrow('INVALID_CROP');
  });
  it('merges concurrent asset requests, retains shared handles until lock and rejects late decryption',async()=>{
    const vaultId=crypto.randomUUID(),key=await importAesKey(randomBytes(32)),asset=await encryptAvatarAsset(key,vaultId,1,'thumb',png(128)),ref={main:asset.reference,thumb:asset.reference,keyVersion:1};let generation=1,loads=0;const controller=new AbortController();
    const cache=new AvatarCache({lease:()=>({vaultId,generation,signal:controller.signal}),check:g=>{if(g!==generation)throw new Error('LOCKED');},key:()=>key,load:async()=>{loads++;return asset.envelope;}});
    const [a,b]=await Promise.all([cache.acquire(ref),cache.acquire(ref)]);expect(loads).toBe(1);expect(a.url).toBe(b.url);a.release();expect((await cache.acquire(ref)).url).toBe(b.url);generation++;cache.clear();b.release();
    let release!:()=>void,started!:()=>void;const deferred=new Promise<void>(r=>{release=r;}),called=new Promise<void>(r=>{started=r;});const later=new AvatarCache({lease:()=>({vaultId,generation,signal:controller.signal}),check:g=>{if(g!==generation)throw new Error('LOCKED');},key:()=>key,load:async()=>{started();await deferred;return asset.envelope;}});const pending=later.acquire(ref);await called;generation++;later.clear();release();await expect(pending).rejects.toThrow('LOCKED');
  });
  it('produces deterministic distinct directory IDs and never uses a person ID as an asset route',async()=>{const id=crypto.randomUUID();expect(await directoryId(id)).toBe(await directoryId(id));expect(await directoryId(id)).not.toBe(id);});
  it('rotates actual data keys, keeps immutable old history and restores old snapshots and assets',async()=>{
    const {engine,server,setup}=await client();const entry=person();await engine.put(entry);await engine.sync();await engine.putAvatar(entry.id,{main:png(512),thumb:png(128)});await engine.sync();const oldBackup=await engine.exportBackup();const oldRecord=server.all.find(e=>e.envelope.recordId===entry.id)!.envelope;
    const rotation=await engine.rotateDataKey('rotated fictional vault phrase 789');expect(rotation.keyVersion).toBe(2);expect(rotation.recoverySecret).not.toBe(setup.recoverySecret);expect(keyBundleSchema.parse(engine.vault!.keyBundle).previousKeys).toHaveLength(1);
    const current=server.all.filter(e=>e.envelope.recordId===entry.id).at(-1)!.envelope;expect(current.keyVersion).toBe(2);expect(current.revision).toBe('3');expect(server.all.find(e=>e.envelope.recordId===entry.id)!.envelope).toEqual(oldRecord);
    const activePerson=engine.entities.find(e=>e.id===entry.id) as Person;expect(activePerson.avatar!.keyVersion).toBe(2);const handle=await engine.acquireAvatar(activePerson.avatar!);handle.release();
    const other=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(other);await other.open(engine.vault!.id);await expect(other.unlock(password)).rejects.toThrow();await other.unlock('rotated fictional vault phrase 789');await other.sync();await other.restore(entry.id,'2');await other.sync();expect((other.entities.find(e=>e.id===entry.id) as Person).avatar!.keyVersion).toBe(2);
    const backup=await other.exportBackup(),preview=await other.previewBackup(backup,rotation.recoverySecret,{recovery:true});expect(preview.assets).toBe(2);expect(preview.people).toBe(1);
    const oldDevice=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(oldDevice);const oldPreview=await oldDevice.previewBackup(oldBackup,setup.recoverySecret,{recovery:true});await oldDevice.importBackup(oldPreview,{confirm:true});await oldDevice.unlock(password);expect((oldDevice.entities.find(e=>e.id===entry.id) as Person).displayName).toBe(entry.displayName);
  });
  it('resumes interrupted key rotation on another device and preserves stale-device candidates',async()=>{
    const {engine:a,server}=await client();const people=Array.from({length:50},(_,i)=>person(`虚构朋友${i}`));await a.saveBatch(people);await a.sync();const {engine:stale}=await device(server);await stale.put({...people[0]!,displayName:'旧设备离线候选'});
    const original=server.commit.bind(server);let interrupted=false;server.commit=async(id,operation)=>{const result=await original(id,operation);if(!interrupted&&operation.mutations[0]!.envelope.keyVersion===2){interrupted=true;a.lock();}return result;};
    await expect(a.rotateDataKey('interrupted fictional new phrase')).rejects.toThrow('VAULT_LOCKED_OPERATION_CANCELLED');
    const fresh=new VaultClient({transport:server,store:new MemoryStore(),ownerId,autoSync:false});clients.push(fresh);await fresh.open(server.descriptor!.id);await fresh.unlock('interrupted fictional new phrase');await fresh.sync();expect(fresh.entities).toHaveLength(50);await fresh.resumeRotation();const latest=new Map(server.all.map(e=>[e.envelope.recordId,e.envelope]));expect([...latest.values()].every(e=>e.lane==='assets'||e.keyVersion===2)).toBe(true);
    await expect(stale.sync()).rejects.toThrow('KEY_ROTATED_REUNLOCK_REQUIRED');expect(stale.state.pending).toBe(1);stale.lock();await stale.open(server.descriptor!.id);await stale.unlock('interrupted fictional new phrase');await stale.sync();expect(stale.state.conflicts).toBe(1);expect((await stale.conflicts())[0]!.code).toBe('KEY_VERSION_CONFLICT');expect((await stale.conflicts())[0]!.local.some(e=>'displayName'in e&&e.displayName==='旧设备离线候选')).toBe(true);
  });
  it('omits orphan assets without dropping any historical referenced image version',async()=>{
    const {engine,server}=await client();const entry=person();await engine.put(entry);await engine.sync();await engine.putAvatar(entry.id,{main:png(512),thumb:png(128)});await engine.sync();await engine.putAvatar(entry.id,{main:png(512),thumb:png(128)});await engine.sync();
    const key=await unwrapKeyBundle(engine.vault!.keyBundle,password),orphan=await encryptAvatarAsset(key.key,engine.vault!.id,1,'thumb',png(128));key.raw.fill(0);await server.commit(engine.vault!.id,{operationId:crypto.randomUUID(),mutations:[{expectedRevision:'0',envelope:orphan.envelope}]});
    const backup=await engine.exportBackup();expect(JSON.parse(backup).envelopes.some((e:CipherEnvelope)=>e.recordId===orphan.envelope.recordId)).toBe(false);expect((await engine.previewBackup(backup,password)).assets).toBe(4);
  });
  it('returns the new recovery secret after a post-install network failure and resumes safely',async()=>{
    const {engine,server}=await client();const people=Array.from({length:50},(_,i)=>person(`虚构轮换人物${i}`));await engine.saveBatch(people);await engine.sync();const original=server.commit.bind(server);let failed=false;
    server.commit=async(id,operation)=>{const result=await original(id,operation);if(!failed&&operation.mutations[0]!.envelope.keyVersion===2){failed=true;server.offline=true;}return result;};
    const result=await engine.rotateDataKey('new fictional interrupted phrase');expect(result.completed).toBe(false);expect(result.recoverySecret.startsWith('ZJ1-')).toBe(true);expect(engine.state.lastError).toBe('OFFLINE');expect(engine.state.rotating).toBe(false);server.offline=false;await engine.resumeRotation();expect(engine.state.pending).toBe(0);
    engine.lock();await engine.open(server.descriptor!.id);await engine.unlock(result.recoverySecret,{recovery:true});await engine.sync();expect(engine.entities).toHaveLength(50);
  });
});
