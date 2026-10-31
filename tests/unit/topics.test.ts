import { afterEach, describe, expect, it } from 'vitest';
import type { CipherEnvelope, Interaction, Operation, Person, PersonReflection, ReflectionInteraction, Tag, Topic, TopicThought, VaultDescriptor } from '@zhijiao/shared';
import { ApiError, MemoryStore, VaultClient, encryptEnvelope, keyBundleSchema, references, unwrapKeyBundle, validateEntity, type KeyBundle, type VaultTransport } from '../../packages/client/src/index.js';

const ownerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const phrase='fictional topic vault unlock phrase';
const base=()=>({id:crypto.randomUUID(),ownerId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const topic=():Topic=>({...base(),kind:'topic',name:'虚构议题：如何面对不确定性',description:'仅用于自动化测试'});
const event=(participantIds:string[]=[]):Interaction=>({...base(),kind:'interaction',title:'虚构来源交往',content:'只含合成内容',participantIds,occurredOn:'2025-03-01'});
const thought=(topicId:string):TopicThought=>({...base(),kind:'thought',topicId,title:'虚构思考标题',content:'一个原则需要根据适用范围判断。',type:'hypothesis',status:'current',recordedOn:'2026-10-31'});
const link=(reflectionId:string,interactionId:string):ReflectionInteraction=>({...base(),kind:'reflectionLink',targetKind:'thought',reflectionId,interactionId,relationType:'arose'});
const person=():Person=>({...base(),kind:'person',displayName:'虚构表达者',status:'active'});
const clients:VaultClient[]=[];

/** Synthetic transport retains the actual authenticated ciphertext and immutable revisions. */
class TopicTransport implements VaultTransport {
  descriptor?:VaultDescriptor; all:Array<{cursor:bigint;envelope:CipherEnvelope}>=[]; cursor=0n; bundles:KeyBundle[]=[];
  operations=new Map<string,{operationId:string;envelopes:CipherEnvelope[];cursor:string}>();
  async list(){return this.descriptor?[structuredClone(this.descriptor)]:[];}
  async get(){if(!this.descriptor)throw new Error('NOT_FOUND');return structuredClone(this.descriptor);}
  async create(id:string,bundle:KeyBundle){this.bundles=[bundle];this.descriptor={id,ownerId,keyBundle:bundle,keyBundleRevision:'1'};return this.get();}
  async keyBundles(){return structuredClone(this.bundles);}
  async rewrap(_id:string,revision:string,bundle:KeyBundle){if(this.descriptor!.keyBundleRevision!==revision)throw new ApiError(409,{code:'REVISION_CONFLICT'});this.bundles.push(bundle);this.descriptor={...this.descriptor!,keyBundle:bundle,keyBundleRevision:(BigInt(revision)+1n).toString()};return this.get();}
  async commit(_id:string,operation:Operation){
    const replay=this.operations.get(operation.operationId);if(replay)return structuredClone(replay);
    const current=new Map(this.all.map(row=>[row.envelope.recordId,row.envelope]));
    if(operation.mutations.some(m=>(current.get(m.envelope.recordId)?.revision??'0')!==m.expectedRevision))throw new ApiError(409,{code:'REVISION_CONFLICT',current:operation.mutations.map(m=>current.get(m.envelope.recordId)).filter((e):e is CipherEnvelope=>!!e)});
    if(operation.mutations.some(m=>m.envelope.keyVersion!==keyBundleSchema.parse(this.descriptor!.keyBundle).keyVersion))throw new ApiError(409,{code:'KEY_VERSION_CONFLICT'});
    this.cursor++;const envelopes=structuredClone(operation.mutations.map(m=>m.envelope));for(const envelope of envelopes)this.all.push({cursor:this.cursor,envelope});
    const result={operationId:operation.operationId,envelopes,cursor:this.cursor.toString()};this.operations.set(operation.operationId,result);return structuredClone(result);
  }
  async changes(_id:string,lane:'directory'|'records',after:string,until?:string){const watermark=until??this.cursor.toString();return {envelopes:structuredClone(this.all.filter(row=>row.cursor>BigInt(after)&&row.cursor<=BigInt(watermark)&&row.envelope.lane===lane).map(row=>row.envelope)),after:watermark,highWatermark:watermark,hasMore:false};}
  async history(_id:string,recordId:string){return structuredClone(this.all.filter(row=>row.envelope.recordId===recordId).map(row=>row.envelope));}
  async assets(){return [];}
  async asset(){throw new Error('NO_SYNTHETIC_ASSETS');}
}
async function setup(){const transport=new TopicTransport(),store=new MemoryStore(),client=new VaultClient({transport,store,ownerId,autoSync:false});clients.push(client);const created=await client.setup(phrase);await client.sync();return {client,transport,store,created};}
async function open(transport:TopicTransport){const client=new VaultClient({transport,store:new MemoryStore(),ownerId,autoSync:false});clients.push(client);await client.open(transport.descriptor!.id);await client.unlock(phrase);await client.sync();return client;}
async function legacyMutation(transport:TopicTransport,recordId:string,payload:unknown,tombstone=false) {
  const descriptor=transport.descriptor!,opened=await unwrapKeyBundle(descriptor.keyBundle,phrase);
  try {
    const previous=transport.all.filter(row=>row.envelope.recordId===recordId).at(-1)!.envelope;
    const envelope=await encryptEnvelope(opened.key,{vaultId:descriptor.id,recordId,revision:(BigInt(previous.revision)+1n).toString(),keyVersion:1,formatVersion:1,lane:'records',tombstone},payload);
    await transport.commit(descriptor.id,{operationId:crypto.randomUUID(),mutations:[{expectedRevision:previous.revision,envelope}]});
  } finally {opened.raw.fill(0);}
}
afterEach(()=>{for(const client of clients.splice(0))client.lock();});

describe('topics and person reflections remain distinct',()=>{
  it('reads legacy reflections and links unchanged, without guessing a topic from content',()=>{
    const p=person();const legacy:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'experience',content:'关于某个原则的旧记录',status:'current',evidence:'旧依据',counterEvidence:'旧反例'};
    expect(validateEntity(legacy)).toEqual(legacy);
    const oldLink:ReflectionInteraction={...base(),kind:'reflectionLink',reflectionId:legacy.id,interactionId:crypto.randomUUID(),relationType:'supports'};
    expect(validateEntity(oldLink)).toEqual(oldLink);expect(references(oldLink)[0]).toEqual({id:legacy.id,kind:'reflection'});
    const t=thought(topic().id);expect('personId' in validateEntity(t)).toBe(false);expect(references(t)).toEqual([{id:t.topicId,kind:'topic'}]);
    expect(()=>validateEntity({...t,personId:p.id})).toThrow();
  });
  it('validates topic identity, thought title, quote type, formation time and unique tag IDs',()=>{
    const t=thought(topic().id);expect(()=>validateEntity({...topic(),name:' '})).toThrow();expect(()=>validateEntity({...t,title:''})).toThrow();
    expect(()=>validateEntity({...t,quote:{text:'引用',kind:'guess'}})).toThrow();expect(()=>validateEntity({...t,recordedAt:'yesterday'})).toThrow();
    const id=crypto.randomUUID();expect(()=>validateEntity({...t,tagIds:[id,id]})).toThrow();
    expect(validateEntity({...t,recordedAt:'2026-10-31T12:30:00Z',quote:{text:'引用',kind:'paraphrase',speakerName:'未建档表达者'}})).toMatchObject({recordedAt:'2026-10-31T12:30:00Z'});
  });
  it('preserves an unresolved authenticated legacy reflection chain through edit, key rotation, backup and history restore',async()=>{
    const {client,transport}=await setup();const p=person(),q=person(),subject=topic();
    const old:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'feeling',content:'虚构旧感受',status:'current'};
    const next:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'experience',content:'虚构后续感受',status:'current',supersedesId:old.id,evidence:'必须保留的旧依据'};
    await client.saveBatch([p,q,subject,old,next]);await client.sync();
    // Simulate the exact encrypted tombstone produced by a pre-feature client.
    await legacyMutation(transport,old.id,{id:old.id,kind:'deleted',previousKind:'reflection'},true);await client.sync();
    const loaded=await open(transport);expect(loaded.entities.find(e=>e.id===next.id)).toEqual(next);expect(loaded.entities.some(e=>e.id===old.id)).toBe(false);
    await loaded.put({...next,content:'修正措辞，保留旧链'});await loaded.sync();
    await expect(loaded.put({...next,supersedesId:crypto.randomUUID()})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(loaded.put({...next,personId:q.id})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(loaded.put({...next,tagIds:[crypto.randomUUID()]})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(loaded.put({...next,quote:{text:'引用',kind:'verbatim',speakerPersonId:crypto.randomUUID()}})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(loaded.put({...next,quote:{text:'引用',kind:'verbatim',sourceInteractionId:crypto.randomUUID()}})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(loaded.put({...thought(subject.id),supersedesId:old.id})).rejects.toThrow('REFERENCE_NOT_FOUND');
    const rotatedPhrase='fictional legacy dangling rotated phrase',rotation=await loaded.rotateDataKey(rotatedPhrase);
    expect(rotation).toMatchObject({completed:true,keyVersion:2});await loaded.resumeRotation();
    const backup=await loaded.exportBackup();expect(backup).not.toContain(next.evidence);
    const clean=new VaultClient({transport,store:new MemoryStore(),ownerId,autoSync:false});clients.push(clean);
    const preview=await clean.previewBackup(backup,rotation.recoverySecret,{recovery:true});await clean.importBackup(preview,{confirm:true});await clean.unlock(rotatedPhrase);
    expect(clean.entities.find(e=>e.id===next.id)).toMatchObject({supersedesId:old.id,evidence:next.evidence});
    await clean.restore(next.id,'1');await clean.sync();expect(clean.entities.find(e=>e.id===next.id)).toMatchObject({content:next.content,supersedesId:old.id});
    await clean.restore(old.id,'1');await clean.sync();expect(clean.entities.find(e=>e.id===old.id)).toMatchObject({content:old.content});
    expect((await clean.history(next.id)).every(entry=>entry.entity?.kind!=='reflection'||entry.entity.supersedesId===old.id)).toBe(true);
  });
  it('preserves an unchanged legacy reflection cycle through rotation and rejects newly introduced invalid links',async()=>{
    const {client,transport}=await setup();const p=person(),q=person();
    const a:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'feeling',content:'虚构旧版感受甲',status:'current'};
    const b:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'experience',content:'虚构旧版感受乙',status:'current',supersedesId:a.id};
    await client.saveBatch([p,q,a,b]);await client.sync();const cyclic={...a,supersedesId:b.id};
    await legacyMutation(transport,a.id,cyclic);await client.sync();const loaded=await open(transport);
    await loaded.put({...cyclic,content:'只修正措辞，不修复旧版歧义'});await loaded.sync();
    await expect(loaded.put({...b,supersedesId:crypto.randomUUID()})).rejects.toThrow('REFERENCE_NOT_FOUND');
    const {supersedesId:_supersedesId,...withoutPrevious}=b;
    await expect(loaded.put({...withoutPrevious,personId:q.id})).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    const rotatedPhrase='fictional legacy cycle rotated phrase',rotation=await loaded.rotateDataKey(rotatedPhrase);
    expect(rotation).toMatchObject({completed:true,keyVersion:2});await loaded.resumeRotation();
    const backup=await loaded.exportBackup(),clean=new VaultClient({transport,store:new MemoryStore(),ownerId,autoSync:false});clients.push(clean);
    const preview=await clean.previewBackup(backup,rotation.recoverySecret,{recovery:true});await clean.importBackup(preview,{confirm:true});await clean.unlock(rotatedPhrase);
    expect(clean.entities.find(e=>e.id===a.id)).toMatchObject({supersedesId:b.id});expect(clean.entities.find(e=>e.id===b.id)).toMatchObject({supersedesId:a.id});
    await clean.restore(a.id,'2');await clean.sync();expect(clean.entities.find(e=>e.id===a.id)).toMatchObject({content:a.content,supersedesId:b.id});
    // An explicit restore to the earlier acyclic version does not license recreating the cycle.
    await clean.restore(a.id,'1');await clean.sync();await expect(clean.put(cyclic)).rejects.toThrow('REVISION_CYCLE');
  });
  it('encrypts, syncs and adds/removes multiple sources while topic rename preserves associations',async()=>{
    const {client,transport,store}=await setup();const subject=topic(),a=event(),b=event(),view=thought(subject.id),first=link(view.id,a.id),second=link(view.id,b.id);
    await client.saveBatch([subject,a,b,view,first]);await client.sync();
    await client.mutateBatch([second],[]);await client.sync();await client.put({...subject,name:'虚构重命名后的议题'});await client.sync();
    const fresh=await open(transport);expect(fresh.entities.find(e=>e.id===view.id)).toMatchObject({topicId:subject.id,recordedOn:'2026-10-31'});
    expect(fresh.entities.filter(e=>e.kind==='reflectionLink'&&e.reflectionId===view.id)).toHaveLength(2);
    await client.mutateBatch([], [first.id]);await client.sync();await fresh.sync();
    expect(fresh.entities.filter(e=>e.kind==='reflectionLink'&&e.reflectionId===view.id).map(e=>e.id)).toEqual([second.id]);
    const stored=JSON.stringify(await store.read(client.vault!.id));expect(stored).not.toContain(subject.name);expect(stored).not.toContain(view.content);expect(stored).not.toContain(phrase);
    expect(transport.all.filter(row=>row.envelope.recordId===subject.id).map(row=>row.envelope.revision)).toEqual(['1','2']);
  });
  it('keeps corrections as revisions and changing understanding as a new linked thought, including backup recovery',async()=>{
    const {client,transport,created}=await setup();const subject=topic(),source=event(),original=thought(subject.id),sourceLink=link(original.id,source.id);
    await client.saveBatch([subject,source,original,sourceLink]);await client.sync();
    const corrected={...original,content:'修正措辞，观点未变'};await client.put(corrected);await client.sync();
    const next={...thought(subject.id),content:'在新情境下需要调整原先的认识。',supersedesId:original.id};await client.saveBatch([next,link(next.id,source.id)]);await client.sync();
    expect((await client.history(original.id)).map(entry=>entry.entity&&'content' in entry.entity?entry.entity.content:undefined)).toEqual([original.content,corrected.content]);
    const backup=await client.exportBackup();expect(backup).not.toContain(next.content);
    const clean=new VaultClient({transport,store:new MemoryStore(),ownerId,autoSync:false});clients.push(clean);
    const preview=await clean.previewBackup(backup,created.recoverySecret,{recovery:true});await clean.importBackup(preview,{confirm:true});await clean.unlock(phrase);
    expect(clean.entities.find(e=>e.id===next.id)).toEqual(next);expect(clean.entities.find(e=>e.id===sourceLink.id)).toEqual(sourceLink);
    await clean.restore(original.id,'1');await clean.sync();expect((await clean.history(original.id)).map(entry=>entry.revision)).toEqual(['1','2','3']);
    expect(clean.entities.find(e=>e.id===original.id)).toMatchObject({content:original.content});
  });
  it('requires correct topic, speaker, tag and source references and keeps evaluated person explicit',async()=>{
    const {client}=await setup();const subject=topic(),speaker=person(),source=event([speaker.id]),view=thought(subject.id),tag:Tag={...base(),kind:'tag',name:'虚构主题标签'};
    await client.saveBatch([subject,speaker,source,tag]);
    await expect(client.put({...view,topicId:speaker.id})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(client.put({...view,tagIds:[speaker.id]})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(client.put({...view,quote:{text:'原话',kind:'verbatim',speakerPersonId:source.id}})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(client.put({...view,quote:{text:'转述',kind:'paraphrase',sourceInteractionId:speaker.id}})).rejects.toThrow('REFERENCE_NOT_FOUND');
    await expect(client.put({...view,ownerId:crypto.randomUUID()})).rejects.toThrow('ENTITY_OWNER_MISMATCH');
    await client.put({...view,tagIds:[tag.id],quote:{text:'原话',kind:'verbatim',speakerPersonId:speaker.id,sourceInteractionId:source.id}});
    const stored=client.entities.find(e=>e.id===view.id)!;expect('personId' in stored).toBe(false);expect(stored.ownerId).toBe(ownerId);
    const feeling:PersonReflection={...base(),kind:'reflection',personId:speaker.id,type:'feeling',content:'只评价明确选择的人物',status:'current'};
    await client.put(feeling);expect(client.entities.filter(e=>e.kind==='reflection'&&e.personId===speaker.id)).toEqual([feeling]);
  });
  it('rejects cross-topic, self and circular understanding chains',async()=>{
    const {client}=await setup();const a=topic(),b=topic(),old=thought(a.id),next={...thought(a.id),supersedesId:old.id};await client.saveBatch([a,b,old,next]);
    await expect(client.put({...thought(b.id),supersedesId:old.id})).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    await expect(client.put({...old,supersedesId:old.id})).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    await expect(client.put({...old,supersedesId:next.id})).rejects.toThrow('REVISION_CYCLE');
  });
  it('protects incoming subject chains while allowing an entire chain to move together',async()=>{
    const {client}=await setup();const a=topic(),b=topic(),old=thought(a.id),next={...thought(a.id),supersedesId:old.id};
    const p=person(),other=person(),feeling:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'feeling',content:'虚构人物感受',status:'current'};
    const later:PersonReflection={...feeling,...base(),content:'虚构后续感受',supersedesId:feeling.id};
    await client.saveBatch([a,b,old,next,p,other,feeling,later]);await client.sync();
    await expect(client.put({...old,topicId:b.id})).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    await expect(client.put({...feeling,personId:other.id})).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    await client.saveBatch([{...old,topicId:b.id},{...next,topicId:b.id}]);await client.sync();
    await expect(client.restore(old.id,'1')).rejects.toThrow('REVISION_SUBJECT_MISMATCH');
    expect(client.entities.find(e=>e.id===old.id)).toMatchObject({topicId:b.id});
  });
  it('preserves thoughts, quote attribution and sources when their speaker is deleted',async()=>{
    const {client}=await setup();const subject=topic(),speaker=person(),source=event([speaker.id]);const view={...thought(subject.id),quote:{text:'对原则的疑问不等于对说话者的评价',kind:'paraphrase' as const,speakerPersonId:speaker.id,sourceInteractionId:source.id}};
    const feeling:PersonReflection={...base(),kind:'reflection',personId:speaker.id,type:'feeling',content:'旧人物感受',status:'current'};const viewLink=link(view.id,source.id),feelingLink:ReflectionInteraction={...base(),kind:'reflectionLink',reflectionId:feeling.id,interactionId:source.id,relationType:'arose'};
    await client.saveBatch([subject,speaker,source,view,viewLink,feeling,feelingLink]);await client.sync();await client.delete(speaker.id);await client.sync();
    expect(client.entities.find(e=>e.id===view.id)).toMatchObject({quote:{speakerName:speaker.displayName,text:view.quote.text,sourceInteractionId:source.id}});
    expect((client.entities.find(e=>e.id===view.id) as TopicThought).quote?.speakerPersonId).toBeUndefined();
    expect(client.entities.find(e=>e.id===source.id)).toMatchObject({participantIds:[]});expect(client.entities.find(e=>e.id===viewLink.id)).toEqual(viewLink);
    expect(client.entities.some(e=>[speaker.id,feeling.id,feelingLink.id].includes(e.id))).toBe(false);
  });
  it('keeps an unrelated person feeling and its provenance when a quoted participant is deleted',async()=>{
    const {client}=await setup();const speaker=person(),evaluated=person(),source=event([speaker.id]);
    const feeling:PersonReflection={...base(),kind:'reflection',personId:evaluated.id,type:'feeling',content:'只评价明确对象',status:'current',quote:{text:'其他人的转述',kind:'paraphrase',speakerPersonId:speaker.id,sourceInteractionId:source.id}};
    const evidence:ReflectionInteraction={...base(),kind:'reflectionLink',reflectionId:feeling.id,interactionId:source.id,relationType:'arose'};
    await client.saveBatch([speaker,evaluated,source,feeling,evidence]);await client.sync();await client.delete(speaker.id);
    expect(client.entities.find(e=>e.id===source.id)).toMatchObject({participantIds:[]});
    expect(client.entities.find(e=>e.id===feeling.id)).toMatchObject({personId:evaluated.id,quote:{speakerName:speaker.displayName,text:feeling.quote!.text}});
    expect(client.entities.find(e=>e.id===evidence.id)).toEqual(evidence);
  });
  it('guards live successor chains and atomically deletes a complete selected chain',async()=>{
    const {client}=await setup();const subject=topic(),source=event(),a=thought(subject.id),b={...thought(subject.id),supersedesId:a.id};
    const p=person(),feeling:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'feeling',content:'虚构旧感受',status:'current'},later:PersonReflection={...base(),kind:'reflection',personId:p.id,type:'experience',content:'虚构新的感受',status:'current'};
    later.supersedesId=feeling.id;
    const aLink=link(a.id,source.id),bLink=link(b.id,source.id);
    await client.saveBatch([subject,source,a,b,p,feeling,later,aLink,bLink]);await client.sync();
    await expect(client.delete(a.id)).rejects.toThrow('REFLECTION_HAS_SUCCESSORS');
    await expect(client.mutateBatch([], [feeling.id])).rejects.toThrow('REFLECTION_HAS_SUCCESSORS');
    expect(client.entities.find(e=>e.id===a.id)).toEqual(a);expect(client.entities.find(e=>e.id===feeling.id)).toEqual(feeling);
    await client.mutateBatch([], [a.id,b.id,feeling.id,later.id]);await client.sync();
    expect(client.entities.filter(e=>['reflection','thought','reflectionLink'].includes(e.kind))).toEqual([]);
    expect(client.entities.find(e=>e.id===source.id)).toEqual(source);
    expect((await client.history(a.id)).at(-1)?.tombstone).toBe(true);expect((await client.history(b.id)).at(-1)?.tombstone).toBe(true);
  });
  it('protects populated topics and only removes the deleted thought links',async()=>{
    const {client}=await setup();const subject=topic(),source=event(),a=thought(subject.id),b=thought(subject.id),aLink=link(a.id,source.id),bLink=link(b.id,source.id);
    await client.saveBatch([subject,source,a,b,aLink,bLink]);await client.sync();
    await expect(client.delete(subject.id)).rejects.toThrow('TOPIC_HAS_THOUGHTS');expect(client.entities.some(e=>e.id===subject.id)).toBe(true);
    await client.delete(a.id);expect(client.entities.some(e=>e.id===aLink.id)).toBe(false);expect(client.entities.find(e=>e.id===bLink.id)).toEqual(bLink);
    await client.mutateBatch([], [b.id,subject.id]);expect(client.entities.filter(e=>['thought','topic','reflectionLink'].includes(e.kind))).toEqual([]);
    expect(client.entities.find(e=>e.id===source.id)).toEqual(source);
  });
  it('removes a tag or quoted source without discarding thought content',async()=>{
    const {client}=await setup();const subject=topic(),source=event(),tag:Tag={...base(),kind:'tag',name:'虚构分类'},view={...thought(subject.id),tagIds:[tag.id],quote:{text:'保留引用正文',kind:'verbatim' as const,sourceInteractionId:source.id}};
    await client.saveBatch([subject,source,tag,view,link(view.id,source.id)]);await client.sync();await client.delete(tag.id);await client.delete(source.id);
    expect(client.entities.find(e=>e.id===view.id)).toMatchObject({content:view.content,tagIds:[],quote:{text:'保留引用正文',kind:'verbatim'}});
    expect((client.entities.find(e=>e.id===view.id) as TopicThought).quote?.sourceInteractionId).toBeUndefined();
  });
  it('rejects legacy link target inference and accepts an explicit thought link',async()=>{
    const {client}=await setup();const subject=topic(),source=event(),view=thought(subject.id);await client.saveBatch([subject,source,view]);
    const explicit=link(view.id,source.id),{targetKind:_targetKind,...legacy}=explicit;
    await expect(client.put(legacy)).rejects.toThrow('REFERENCE_NOT_FOUND');await client.put(explicit);
    expect(client.entities.find(e=>e.id===explicit.id)).toEqual(explicit);
  });
});
