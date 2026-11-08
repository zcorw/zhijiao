import { z } from 'zod';
import { opaqueId, partialDateSchema, type Entity, type Person, type DirectoryEntry } from '@zhijiao/shared';
import { directoryId, wrappedKeySchema } from './crypto.js';

const optionalText = z.string().max(100_000).optional();
const ids = z.array(opaqueId).max(1000).refine(v => new Set(v).size === v.length);
const base = {id:opaqueId,ownerId:opaqueId,createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()};
const assetRef = z.strictObject({ id:opaqueId, revision:z.string().regex(/^[1-9]\d{0,18}$/), keyEnvelope:wrappedKeySchema });
const avatar = z.strictObject({main:assetRef,thumb:assetRef,keyVersion:z.number().int().min(1).max(1_000_000)});
const quote = z.strictObject({text:z.string().trim().min(1).max(100_000),kind:z.enum(['verbatim','paraphrase']),speakerPersonId:opaqueId.optional(),speakerName:z.string().trim().max(200).optional(),sourceInteractionId:opaqueId.optional()});
const reflectionContent = {title:z.string().trim().max(300).optional(),type:z.enum(['feeling','hypothesis','experience']),content:z.string().min(1).max(100_000),context:optionalText,evidence:optionalText,counterEvidence:optionalText,certainty:optionalText,recordedOn:partialDateSchema.optional(),recordedAt:z.iso.datetime({offset:true}).optional(),status:z.enum(['current','revised','withdrawn']),supersedesId:opaqueId.optional(),tagIds:ids.optional(),quote:quote.optional()};
export const entitySchema = z.discriminatedUnion('kind',[
  z.strictObject({...base,kind:z.literal('person'),displayName:z.string().trim().min(1).max(200),fullName:z.string().trim().max(200).optional(),aliases:z.array(z.string().trim().min(1).max(200)).max(100).optional(),avatar:avatar.optional(),summary:optionalText,metContext:optionalText,metOn:partialDateSchema.optional(),birthday:partialDateSchema.optional(),notes:optionalText,status:z.enum(['active','archived'])}),
  z.strictObject({...base,kind:z.literal('directory'),personId:opaqueId,displayName:z.string().min(1).max(200),aliases:z.array(z.string().max(200)).max(101),distinguishing:z.string().max(300).optional(),avatar:avatar.optional(),status:z.enum(['active','archived'])}),
  z.strictObject({...base,kind:z.literal('contact'),personId:opaqueId,type:z.string().min(1).max(200),value:z.string().min(1).max(10_000),label:optionalText,preferred:z.boolean().optional(),status:z.enum(['active','inactive','unconfirmed'])}),
  z.strictObject({...base,kind:z.literal('fact'),personId:opaqueId,category:optionalText,content:z.string().min(1).max(100_000),basis:z.enum(['self-reported','observation','third-party']),sourceNote:optionalText,sourceInteractionId:opaqueId.optional(),learnedOn:partialDateSchema.optional(),validFrom:partialDateSchema.optional(),validTo:partialDateSchema.optional(),status:z.enum(['current','unconfirmed','outdated']),supersedesFactId:opaqueId.optional()}),
  z.strictObject({...base,kind:z.literal('interaction'),title:z.string().min(1).max(300),participantIds:ids,kindOfInteraction:optionalText,occurredOn:partialDateSchema.optional(),occurredAt:z.iso.datetime({offset:true}).optional(),timezone:optionalText,channel:optionalText,location:optionalText,content:z.string().max(100_000)}),
  z.strictObject({...base,kind:z.literal('reflection'),personId:opaqueId,...reflectionContent}),
  z.strictObject({...base,kind:z.literal('topic'),name:z.string().trim().min(1).max(200),description:optionalText}),
  z.strictObject({...base,kind:z.literal('thought'),topicId:opaqueId,...reflectionContent,title:z.string().trim().min(1).max(300)}),
  z.strictObject({...base,kind:z.literal('reflectionLink'),reflectionId:opaqueId,targetKind:z.enum(['reflection','thought']).optional(),interactionId:opaqueId,relationType:z.enum(['arose','supports','contradicts','revises']),explanation:optionalText}),
  z.strictObject({...base,kind:z.literal('followUp'),title:z.string().min(1).max(300),personIds:ids.refine(v=>v.length>=1),type:z.enum(['promise','plan']),responsibility:z.enum(['me','other','joint']),sourceInteractionId:opaqueId.optional(),details:optionalText,dueDate:partialDateSchema.optional(),dueAt:z.iso.datetime({offset:true}).optional(),timezone:optionalText,status:z.enum(['pending','completed','cancelled']),completedAt:z.iso.datetime({offset:true}).optional()}),
  z.strictObject({...base,kind:z.literal('tag'),name:z.string().min(1).max(200),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()}),
  z.strictObject({...base,kind:z.literal('personTag'),personId:opaqueId,tagId:opaqueId})
]);
export function validateEntity(value: unknown): Entity { return entitySchema.parse(value) as Entity; }
export async function personDirectory(person: Person): Promise<DirectoryEntry> {
  const aliases=[...new Set([person.fullName??'',...person.aliases??[]].filter(name=>name&&name!==person.displayName))];
  return {id:await directoryId(person.id),ownerId:person.ownerId,createdAt:person.createdAt,updatedAt:person.updatedAt,kind:'directory',personId:person.id,displayName:person.displayName,aliases,distinguishing:person.summary?.slice(0,300) ?? person.metContext?.slice(0,300),avatar:person.avatar,status:person.status};
}
export function references(entity: Entity): Array<{id:string;kind:Entity['kind']}> {
  switch (entity.kind) {
    case 'directory': case 'contact': case 'fact': return [{id:entity.personId,kind:'person'}];
    case 'reflection': case 'thought': return [
      entity.kind==='reflection'?{id:entity.personId,kind:'person'}:{id:entity.topicId,kind:'topic'},
      ...(entity.tagIds??[]).map(id=>({id,kind:'tag' as const})),
      ...(entity.supersedesId?[{id:entity.supersedesId,kind:entity.kind}]:[]),
      ...(entity.quote?.speakerPersonId?[{id:entity.quote.speakerPersonId,kind:'person' as const}]:[]),
      ...(entity.quote?.sourceInteractionId?[{id:entity.quote.sourceInteractionId,kind:'interaction' as const}]:[])
    ];
    case 'interaction': return entity.participantIds.map(id => ({id,kind:'person'}));
    case 'followUp': return entity.personIds.map(id => ({id,kind:'person'}));
    case 'reflectionLink': return [{id:entity.reflectionId,kind:entity.targetKind??'reflection'},{id:entity.interactionId,kind:'interaction'}];
    case 'personTag': return [{id:entity.personId,kind:'person'},{id:entity.tagId,kind:'tag'}];
    default: return [];
  }
}
/** Revision chains represent a changing view of the same subject, never an inferred attribution. */
export function validateReflectionSubject(entity: Entity, known: ReadonlyMap<string, Entity>): void {
  if ((entity.kind!=='reflection' && entity.kind!=='thought') || !entity.supersedesId) return;
  const previous=known.get(entity.supersedesId);
  if (previous?.kind!==entity.kind || previous.id===entity.id || (previous.kind==='thought' && entity.kind==='thought' ? previous.topicId!==entity.topicId : previous.kind==='reflection' && entity.kind==='reflection' && previous.personId!==entity.personId)) throw new Error('REVISION_SUBJECT_MISMATCH');
  const visited=new Set([entity.id]);let cursor:Entity|undefined=previous;
  while(cursor && (cursor.kind==='reflection'||cursor.kind==='thought')) {
    if(visited.has(cursor.id))throw new Error('REVISION_CYCLE');visited.add(cursor.id);
    cursor=cursor.supersedesId?known.get(cursor.supersedesId):undefined;
  }
}
/** Preserve authenticated legacy ambiguity without permitting a new or changed invalid chain. */
export function preservesLegacyReflectionChain(entity:Entity,baseline:ReadonlyMap<string,Entity>,known:ReadonlyMap<string,Entity>):boolean {
  if(entity.kind!=='reflection'||!entity.supersedesId)return false;
  const original=baseline.get(entity.id);
  if(original?.kind!=='reflection'||original.personId!==entity.personId||original.supersedesId!==entity.supersedesId)return false;
  try { validateReflectionSubject(original,baseline);return false; } catch { /* Older clients allowed unresolved or cyclic chains. */ }
  const visited=new Set<string>();let id:string|undefined=entity.id;
  while(id&&!visited.has(id)) {
    visited.add(id);const before=baseline.get(id),after=known.get(id);
    if(!before)return !after;
    if(before.kind!=='reflection')return after?.kind===before.kind;
    if(after?.kind!=='reflection'||before.personId!==after.personId||before.supersedesId!==after.supersedesId)return false;
    id=before.supersedesId;
  }
  return true;
}
/** Preserve a shared interaction and its other participants when deleting a person. */
export function planPersonDeletion(personId: string, entities: Entity[]): {updates:Entity[];deleteIds:string[]} {
  const updates: Entity[] = []; const deleteIds = new Set([personId]); const now = new Date().toISOString();
  const retainedReflections=new Set(entities.filter(entity=>entity.kind==='thought'||entity.kind==='reflection'&&entity.personId!==personId).map(entity=>entity.id));
  const sourceIds=new Set(entities.flatMap(entity=>entity.kind==='reflectionLink'&&retainedReflections.has(entity.reflectionId)?[entity.interactionId]:(entity.kind==='thought'||entity.kind==='reflection')&&retainedReflections.has(entity.id)&&entity.quote?.sourceInteractionId?[entity.quote.sourceInteractionId]:[]));
  const speaker=entities.find((entity):entity is Person=>entity.kind==='person'&&entity.id===personId);
  for (const e of entities) {
    if ('personId' in e && e.personId === personId) deleteIds.add(e.id);
    if (e.kind === 'interaction' && e.participantIds.includes(personId)) {
      const participantIds = e.participantIds.filter(id => id !== personId);
      if (participantIds.length || sourceIds.has(e.id)) updates.push({...e,participantIds,updatedAt:now}); else deleteIds.add(e.id);
    }
    if (e.kind === 'followUp' && e.personIds.includes(personId)) {
      const personIds=e.personIds.filter(id=>id!==personId);
      if(personIds.length)updates.push({...e,personIds,updatedAt:now});else deleteIds.add(e.id);
    }
    if ((e.kind==='thought'||e.kind==='reflection') && !deleteIds.has(e.id) && e.quote?.speakerPersonId===personId) {
      const {speakerPersonId:_speakerPersonId,...quote}=e.quote;
      updates.push({...e,quote:{...quote,speakerName:quote.speakerName??speaker?.displayName??'已删除的人物'},updatedAt:now});
    }
  }
  for (const e of entities) if (e.kind === 'reflectionLink' && (deleteIds.has(e.reflectionId) || deleteIds.has(e.interactionId))) deleteIds.add(e.id);
  return {updates,deleteIds:[...deleteIds]};
}
