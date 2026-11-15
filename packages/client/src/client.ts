import { pinyin } from 'pinyin-pro';
import { opaqueId, type AvatarRef, type CipherEnvelope, type DirectoryEntry, type Entity, type Operation, type Person } from '@zhijiao/shared';
import { decryptBytes, directoryId, encryptBytes, keyBundleSchema, ownerPersonId } from './crypto.js';
import { AvatarCache, assetKeyAad, encryptAvatarAsset, prepareAvatar, type AvatarCrop, type PreparedAvatar } from './avatar.js';
import { personDirectory, planPersonDeletion, references, validateEntity, validateReflectionSubject, preservesLegacyReflectionChain } from './entities.js';
import { IndexedDbStore, type StoredVault, type VaultStore } from './storage.js';
import { exportEncryptedBackup, previewEncryptedBackup, getPreviewData, type BackupPreview } from './backup.js';

import { VaultClient as EncryptedVaultClient, type ClientOptions as CoreOptions, type Lease, type PreparedWrite } from '@zcorw/encrypted-vault';
export type { ClientState } from '@zcorw/encrypted-vault';
export type HistoryEntry = import('@zcorw/encrypted-vault').HistoryEntry<Entity>;
export type ConflictView = import('@zcorw/encrypted-vault').ConflictView<Entity>;
export type ClientOptions = Omit<CoreOptions<Entity>, 'adapter'|'store'> & {store?:VaultStore};
const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\s'’_-]+/g,'');
const reflectionSubject=(entity:Entity|undefined)=>entity?.kind==='thought'?entity.topicId:entity?.kind==='reflection'?entity.personId:undefined;
function validateIncomingReflectionSubjects(entity:Entity,known:ReadonlyMap<string,Entity>,deleteIds:string[]=[],baseline:ReadonlyMap<string,Entity>=known):void {
  if(entity.kind!=='reflection'&&entity.kind!=='thought')return;
  for(const candidate of known.values())if(candidate.kind===entity.kind&&candidate.supersedesId===entity.id&&!deleteIds.includes(candidate.id)&&!preservesLegacyReflectionChain(candidate,baseline,known))validateReflectionSubject(candidate,known);
}
export class VaultClient extends EncryptedVaultClient<Entity> {
  private defaultPerson?:{person:Person;directory:DirectoryEntry};
  private recent:string[]=[];
  private searchIndex=new Map<string,string[]>();
  private readonly avatarCache:AvatarCache;
  constructor(options:ClientOptions){
    super({...options,store:options.store??new IndexedDbStore(),adapter:{parse:validateEntity,lane:e=>e.kind==='directory'?'directory':'records'}});
    this.avatarCache=new AvatarCache({lease:()=>this.lease(),check:g=>this.check(g),key:v=>this.key(v),load:(id,revision,signal)=>this.loadAsset(id,revision,signal)});
  }
  get selfPersonId():string|undefined{return this.defaultPerson?.person.id;}
  get directoryEntries():DirectoryEntry[]{return this.unlocked?structuredClone([...this.plain.values()].filter((e):e is DirectoryEntry=>e.kind==='directory')):[];}
  protected override onLock():void{this.defaultPerson=undefined;this.searchIndex.clear();this.recent=[];this.avatarCache.clear();}
  protected override async hydrateRecords(result:Map<string,Entity>,current:Map<string,CipherEnvelope>,generation:number):Promise<void>{
    if(!this.defaultPerson){
      const vault=this.descriptor!,date=new Date(0).toISOString();
      const person:Person={id:await ownerPersonId(vault.id),ownerId:vault.ownerId,kind:'person',displayName:'我',status:'active',createdAt:date,updatedAt:date};
      const directory=await personDirectory(person);
      this.check(generation);this.defaultPerson={person,directory};
    }
    // The built-in profile needs no sync write until edited. A downloaded directory entry
    // takes precedence while the saved profile is still being downloaded.
    const {person,directory}=this.defaultPerson;
    if(!current.has(person.id)&&!current.has(directory.id)){
      result.set(person.id,person);result.set(directory.id,directory);
    }
    this.check(generation);this.searchIndex.clear();
    for(const entry of [...result.values()].filter((e):e is DirectoryEntry=>e.kind==='directory')){const names=[entry.displayName,...entry.aliases];this.searchIndex.set(entry.personId,names.flatMap(name=>[normalize(name),normalize(pinyin(name,{toneType:'none',type:'array',mode:'surname'}).join('')),normalize(pinyin(name,{pattern:'first',toneType:'none',type:'array',mode:'surname'}).join(''))]));}
  }
  markPersonUsed(id:string):void{if(!this.unlocked)return;this.recent=[id,...this.recent.filter(v=>v!==id)].slice(0,5);}
  searchPeople(query:string,options:{includeArchived?:boolean}={}):{entries:DirectoryEntry[];complete:boolean}{
    if(!this.unlocked)return {entries:[],complete:false};const normalized=normalize(query);
    let entries=this.directoryEntries.filter(e=>options.includeArchived||e.status==='active');
    if(normalized)entries=entries.filter(e=>this.searchIndex.get(e.personId)?.some(v=>v.includes(normalized)));
    else entries.sort((a,b)=>{
      const selfFirst=Number(b.personId===this.selfPersonId)-Number(a.personId===this.selfPersonId);
      if(selfFirst)return selfFirst;
      const aIndex=this.recent.indexOf(a.personId),bIndex=this.recent.indexOf(b.personId);if(aIndex>=0 || bIndex>=0)return (aIndex<0?99:aIndex)-(bIndex<0?99:bIndex);return b.updatedAt.localeCompare(a.updatedAt);
    });
    return {entries:normalized?entries:entries.slice(0,5),complete:this.stateValue.directoryComplete};
  }
  mutateBatch(entities:Entity[],deleteIds:string[]):Promise<Operation>{
    const lease=this.lease();return this.queue(async()=>{
      this.check(lease.generation);const updates=new Map(entities.map(e=>[e.id,e])),working=new Map(this.plain),deletes=new Set(deleteIds);
      if(new Set([...entities.map(e=>e.id),...deleteIds]).size!==entities.length+deleteIds.length)throw new Error('DUPLICATE_MUTATION');
      for(const e of entities)working.set(e.id,e);
      for(const id of deleteIds){opaqueId.parse(id);const entity=this.plain.get(id);if(!entity)throw new Error('ENTITY_NOT_FOUND');
        if(id===this.selfPersonId)throw new Error('CANNOT_DELETE_SELF_PERSON');
        if(entity.kind==='person'){
          if(!this.stateValue.recordsComplete)throw new Error('FULL_SYNC_REQUIRED_TO_DELETE_PERSON');const plan=planPersonDeletion(id,[...working.values()]);
          for(const e of plan.updates){working.set(e.id,e);updates.set(e.id,e);}for(const deleted of plan.deleteIds){deletes.add(deleted);working.delete(deleted);updates.delete(deleted);}
        }
        if(entity.kind==='topic') {
          if(!this.stateValue.recordsComplete)throw new Error('FULL_SYNC_REQUIRED_TO_DELETE_TOPIC');
          if([...working.values()].some(e=>e.kind==='thought'&&e.topicId===id&&!deletes.has(e.id)))throw new Error('TOPIC_HAS_THOUGHTS');
        }
        if((entity.kind==='reflection'||entity.kind==='thought')&&[...working.values()].some(e=>e.kind===entity.kind&&e.supersedesId===id&&!deletes.has(e.id)))throw new Error('REFLECTION_HAS_SUCCESSORS');
        if(entity.kind==='interaction'||entity.kind==='reflection'||entity.kind==='thought')for(const e of working.values())if(e.kind==='reflectionLink'&&(e.interactionId===id || e.reflectionId===id)){deletes.add(e.id);updates.delete(e.id);working.delete(e.id);}
        if(entity.kind==='tag')for(const e of working.values()) {
          if(e.kind==='personTag'&&e.tagId===id){deletes.add(e.id);updates.delete(e.id);working.delete(e.id);}
          if((e.kind==='reflection'||e.kind==='thought')&&e.tagIds?.includes(id)&&!deletes.has(e.id)) {
            const next={...e,tagIds:e.tagIds.filter(tagId=>tagId!==id),updatedAt:new Date().toISOString()};updates.set(e.id,next);working.set(e.id,next);
          }
        }
        if(entity.kind==='interaction')for(const e of working.values())if((e.kind==='reflection'||e.kind==='thought')&&e.quote?.sourceInteractionId===id&&!deletes.has(e.id)) {
          const {sourceInteractionId:_sourceInteractionId,...quote}=e.quote;
          const next={...e,quote,updatedAt:new Date().toISOString()};updates.set(e.id,next);working.set(e.id,next);
        }
      }
      for(const id of deletes)updates.delete(id);
      return this.write([...updates.values()],[...deletes],[],lease);
    });
  }
  protected override async prepareWrite(inputs:Entity[],deleteIds:string[],current:Map<string,CipherEnvelope>):Promise<PreparedWrite<Entity>>{
    const entities=inputs.map(validateEntity);
    if(entities.some(e=>e.kind==='directory'))throw new Error('DIRECTORY_IS_DERIVED');
    if(new Set([...entities.map(e=>e.id),...deleteIds]).size!==entities.length+deleteIds.length)throw new Error('DUPLICATE_MUTATION');
    const known=new Map(this.plain);for(const e of entities){if(e.ownerId!==this.descriptor!.ownerId)throw new Error('ENTITY_OWNER_MISMATCH');known.set(e.id,e);}
    const legacyChains=new Set(entities.filter(e=>preservesLegacyReflectionChain(e,this.plain,known)).map(e=>e.id));
    for(const e of entities)for(const ref of references(e)){
      if(legacyChains.has(e.id)&&e.kind==='reflection'&&ref.kind==='reflection'&&ref.id===e.supersedesId&&!deleteIds.includes(ref.id))continue;
      const target=known.get(ref.id);const personKnown=ref.kind==='person'&&this.directoryEntries.some(p=>p.personId===ref.id);
      if(target?.kind!==ref.kind&&!personKnown)throw new Error('REFERENCE_NOT_FOUND');if(deleteIds.includes(ref.id))throw new Error('REFERENCE_TO_DELETED_ENTITY');
    }
    for(const e of entities) {
      if(e.id===this.selfPersonId){
        if(e.kind!=='person'||e.displayName!=='我'||e.status!=='active')throw new Error('INVALID_SELF_PERSON');
        const {person,directory}=this.defaultPerson!;
        // A form opened on the built-in profile must not overwrite a newly downloaded edit.
        if(e.createdAt===person.createdAt&&(current.has(e.id)||current.has(directory.id)))throw new Error('LOCAL_REVISION_CONFLICT');
        if(!current.has(e.id))e.createdAt=e.updatedAt;
      }
      if(!legacyChains.has(e.id))validateReflectionSubject(e,known);
      const previous=this.plain.get(e.id);
      if(previous&&reflectionSubject(previous)!==reflectionSubject(e))validateIncomingReflectionSubjects(e,known,deleteIds,this.plain);
    }
    for(const e of entities.filter((e):e is Person=>e.kind==='person'))entities.push(await personDirectory(e));
    const expandedDeletes=new Set(deleteIds);for(const id of deleteIds)if(this.plain.get(id)?.kind==='person')expandedDeletes.add(await directoryId(id));
    return {entities,deleteIds:[...expandedDeletes]};
  }
  protected override async prepareRestore(entity:Entity,keyVersion:number,lease:Lease):Promise<Entity[]>{
    if(entity.kind==='directory')throw new Error('DIRECTORY_IS_DERIVED');
    const restorationKnown=new Map(this.plain).set(entity.id,entity);
    // The source is an authenticated history entry selected through restore(), never a new supplied link.
    const legacyChain=preservesLegacyReflectionChain(entity,restorationKnown,restorationKnown);
    for(const ref of references(entity)){
      if(legacyChain&&entity.kind==='reflection'&&ref.kind==='reflection'&&ref.id===entity.supersedesId)continue;
      const target=this.plain.get(ref.id),personKnown=ref.kind==='person'&&this.directoryEntries.some(p=>p.personId===ref.id);
      if(target?.kind!==ref.kind&&!personKnown)throw new Error('REFERENCE_NOT_FOUND_RESTORE_DEPENDENCIES_FIRST');
    }
    if(!legacyChain)validateReflectionSubject(entity,restorationKnown);
    validateIncomingReflectionSubjects(entity,restorationKnown,[],this.plain);
    const restored={...entity,updatedAt:new Date().toISOString()};if(restored.kind==='person'&&restored.avatar)restored.avatar=await this.rewrapAvatar(restored.avatar,keyVersion,lease);
    const entities:Entity[]=[restored];if(entity.kind==='person')entities.push(await personDirectory(entities[0] as Person));
    return entities;
  }
  private async rewrapAvatar(ref:AvatarRef,keyVersion:number,lease:Lease):Promise<AvatarRef>{
    if(ref.keyVersion===keyVersion)return ref;const result:AvatarRef={...ref,keyVersion};
    for(const variant of ['main','thumb'] as const){const target=ref[variant];if(!target.keyEnvelope)throw new Error('ASSET_KEY_ENVELOPE_MISSING');
      const raw=await decryptBytes(this.key(ref.keyVersion),target.keyEnvelope,assetKeyAad(lease.vaultId,target.id,target.revision,variant,ref.keyVersion));
      try{this.check(lease.generation);if(raw.length!==32)throw new Error('INVALID_ASSET_KEY_LENGTH');const keyEnvelope=await encryptBytes(this.key(keyVersion),raw,assetKeyAad(lease.vaultId,target.id,target.revision,variant,keyVersion));this.check(lease.generation);result[variant]={...target,keyEnvelope};}finally{raw.fill(0);}
    }
    return result;
  }
  protected override async rotateRecord(entity:Entity,version:number,lease:Lease):Promise<Entity>{
    const next={...entity};if(next.kind==='person'&&next.avatar)next.avatar=await this.rewrapAvatar(next.avatar,version,lease);return next;
  }
  prepareAvatar(file:Blob,crop?:AvatarCrop):Promise<PreparedAvatar>{const lease=this.lease();return prepareAvatar(file,crop).then(result=>{try{this.check(lease.generation);return result;}catch(e){result.main.fill(0);result.thumb.fill(0);throw e;}});}
  putAvatar(personId:string,prepared:PreparedAvatar):Promise<Operation>{const lease=this.lease();return this.queue(async()=>{
    this.check(lease.generation);const person=this.plain.get(personId);if(person?.kind!=='person')throw new Error('PERSON_NOT_FOUND');const keyVersion=keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion,key=this.key(keyVersion);
    const main=await encryptAvatarAsset(key,lease.vaultId,keyVersion,'main',prepared.main);this.check(lease.generation);const thumb=await encryptAvatarAsset(key,lease.vaultId,keyVersion,'thumb',prepared.thumb);this.check(lease.generation);
    return this.write([{...person,updatedAt:new Date().toISOString(),avatar:{main:main.reference,thumb:thumb.reference,keyVersion}}],[],[main.envelope,thumb.envelope],lease);
  });}
  acquireAvatar(ref:AvatarRef,variant:'main'|'thumb'='thumb'){return this.avatarCache.acquire(ref,variant);}
  protected override exportStoredBackup(stored:StoredVault,key:CryptoKey,getKey:(version:number)=>CryptoKey):Promise<string>{return exportEncryptedBackup(stored,key,getKey);}
  protected override previewStoredBackup(text:string,secret:string,options:{recovery?:boolean}):Promise<BackupPreview>{return previewEncryptedBackup(text,secret,options);}
  protected override previewData(preview:BackupPreview):StoredVault{return getPreviewData(preview);}
  override previewBackup(text:string,secret:string,options:{recovery?:boolean}={}):Promise<BackupPreview>{return super.previewBackup(text,secret,options) as Promise<BackupPreview>;}
}
export { VaultClient as ClientEngine };
