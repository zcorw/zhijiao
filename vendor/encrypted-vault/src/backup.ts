import { z } from 'zod';
import { decimal, envelopeSchema, opaqueId, operationSchema, type CipherEnvelope } from './protocol.js';
import { base64, decryptBytes, decryptEnvelope, encryptBytes, jsonBytes, keyBundleSchema, parseBytes, sha256, unwrapKeyBundle, unwrapPreviousKeys, unbase64, type KeyBundle } from './crypto.js';
import type { RecordAdapter, VaultRecord } from './adapter.js';
import { envelopeIdentity, type StoredVault } from './storage.js';

const maxBytes=200_000_000;
const vaultSchema=z.strictObject({id:opaqueId,ownerId:opaqueId,keyBundle:keyBundleSchema,keyBundleRevision:decimal});
const wrappedManifest=z.strictObject({nonce:z.string().length(16),ciphertext:z.string().min(24).max(1024)});
const bodySchema=z.strictObject({
  format:z.literal('encrypted-vault-backup'),formatVersion:z.literal(1),vault:vaultSchema,
  keyBundles:z.array(keyBundleSchema).min(1).max(1000),envelopes:z.array(envelopeSchema).max(100_000),
  outbox:z.array(z.strictObject({operation:operationSchema,status:z.enum(['pending','conflict']),current:z.array(envelopeSchema).max(100).optional(),conflictCode:z.enum(['REVISION_CONFLICT','KEY_VERSION_CONFLICT']).optional()})).max(10_000)
});
const backupSchema=bodySchema.extend({manifest:wrappedManifest});
const manifestSchema=z.strictObject({digest:z.string().length(44),createdAt:z.iso.datetime(),envelopes:z.number().int().min(0).max(100_000),assets:z.number().int().min(0).max(100_000),pending:z.number().int().min(0).max(10_000)});
export interface BackupPreview {readonly vaultId:string;readonly createdAt:string;readonly records:number;readonly assets:number;readonly pending:number}
const validated=new WeakMap<BackupPreview,StoredVault>();
const backupAad=(vaultId:string)=>JSON.stringify(['encrypted-vault-backup',vaultId,1]);
export async function exportEncryptedBackup<T extends VaultRecord>(stored:StoredVault,key:CryptoKey,getKey:(version:number)=>CryptoKey,adapter:RecordAdapter<T>):Promise<string>{
  // Asset key envelopes belong to the business payload; a host subclass must verify them.
  if([...stored.envelopes,...stored.outbox.flatMap(o=>[...o.operation.mutations.map(m=>m.envelope),...o.current??[]])].some(e=>e.lane==='assets'))throw new Error('BACKUP_ASSET_ADAPTER_REQUIRED');
  const envelopes=stored.envelopes;
  for(const envelope of [...envelopes,...stored.outbox.flatMap(o=>[...o.operation.mutations.map(m=>m.envelope),...o.current??[]])]){
    const payload=await decryptEnvelope(getKey(envelope.keyVersion),envelope);
    validatePayload(payload,envelope,stored.descriptor.ownerId,adapter);
  }
  const body=bodySchema.parse({format:'encrypted-vault-backup',formatVersion:1,vault:{id:stored.descriptor.id,ownerId:stored.descriptor.ownerId,keyBundle:stored.descriptor.keyBundle,keyBundleRevision:stored.descriptor.keyBundleRevision},keyBundles:stored.keyBundles,envelopes,outbox:stored.outbox});
  const manifest={digest:await sha256(body),createdAt:new Date().toISOString(),envelopes:body.envelopes.length,assets:body.envelopes.filter(e=>e.lane==='assets').length,pending:body.outbox.length};
  const result=JSON.stringify({...body,manifest:await encryptBytes(key,jsonBytes(manifest),backupAad(body.vault.id))});
  if(new TextEncoder().encode(result).length>maxBytes)throw new Error('BACKUP_SIZE_LIMIT_200MB');return result;
}
function checkEnvelope(e:CipherEnvelope,vaultId:string):void{
  if(e.vaultId!==vaultId)throw new Error('BACKUP_CROSS_VAULT_RECORD');unbase64(e.nonce,12);const ciphertext=unbase64(e.ciphertext);if(ciphertext.length<16)throw new Error('BACKUP_INVALID_CIPHERTEXT');
}
export async function previewEncryptedBackup<T extends VaultRecord>(text:string,secret:string,adapter:RecordAdapter<T>,options:{recovery?:boolean}={}):Promise<BackupPreview>{
  if(typeof text!=='string' || text.length>maxBytes || new TextEncoder().encode(text).length>maxBytes)throw new Error('BACKUP_SIZE_LIMIT_200MB');
  const input=backupSchema.parse(JSON.parse(text));const {manifest:encryptedManifest,...body}=input;
  if(body.vault.keyBundle.vaultId!==body.vault.id || body.keyBundles.some(b=>b.vaultId!==body.vault.id))throw new Error('BACKUP_KEY_BUNDLE_VAULT_MISMATCH');
  if(!body.keyBundles.some(b=>JSON.stringify(b)===JSON.stringify(body.vault.keyBundle)))throw new Error('BACKUP_CURRENT_BUNDLE_MISSING');
  unbase64(encryptedManifest.nonce,12);unbase64(encryptedManifest.ciphertext);
  const opened=await unwrapKeyBundle(body.vault.keyBundle,secret,options.recovery);const keys=new Map<number,{raw:Uint8Array;key:CryptoKey}>();keys.set(opened.bundle.keyVersion,opened);
  try{
    for(const [version,key] of await unwrapPreviousKeys(opened.bundle,opened.key))keys.set(version,key);
    const manifestBytes=await decryptBytes(opened.key,encryptedManifest,backupAad(body.vault.id));let manifest:z.infer<typeof manifestSchema>;
    try{manifest=manifestSchema.parse(parseBytes(manifestBytes));}finally{manifestBytes.fill(0);}
    if(manifest.digest!==await sha256(body) || manifest.envelopes!==body.envelopes.length || manifest.assets!==body.envelopes.filter(e=>e.lane==='assets').length || manifest.pending!==body.outbox.length)throw new Error('BACKUP_MANIFEST_MISMATCH');
    const versions=new Set([...body.envelopes,...body.outbox.flatMap(o=>[...o.operation.mutations.map(m=>m.envelope),...o.current??[]])].map(e=>e.keyVersion));
    for(const version of versions)if(!keys.has(version)){
      const bundle=[...body.keyBundles].reverse().find(b=>b.keyVersion===version);if(!bundle)throw new Error('BACKUP_KEY_VERSION_MISSING');
      const item=await unwrapKeyBundle(bundle,secret,options.recovery);keys.set(version,item);
    }
    const unique=new Map<string,CipherEnvelope>();
    for(const e of body.envelopes){checkEnvelope(e,body.vault.id);const identity=envelopeIdentity(e);if(unique.has(identity))throw new Error('BACKUP_DUPLICATE_HISTORY');unique.set(identity,e);}
    const operationIds=new Set<string>();
    for(const pending of body.outbox){
      if(operationIds.has(pending.operation.operationId))throw new Error('BACKUP_DUPLICATE_OPERATION');operationIds.add(pending.operation.operationId);
      for(const m of pending.operation.mutations){checkEnvelope(m.envelope,body.vault.id);if(BigInt(m.envelope.revision)!==BigInt(m.expectedRevision)+1n)throw new Error('BACKUP_REVISION_MISMATCH');}
      for(const e of pending.current??[])checkEnvelope(e,body.vault.id);
    }
    const all=[...body.envelopes,...body.outbox.flatMap(o=>[...o.operation.mutations.map(m=>m.envelope),...o.current??[]])];
    for(const e of all){
      if(e.lane==='assets')throw new Error('BACKUP_ASSET_ADAPTER_REQUIRED');
      const key=keys.get(e.keyVersion)?.key;if(!key)throw new Error('BACKUP_KEY_VERSION_MISSING');
      validatePayload(await decryptEnvelope(key,e),e,body.vault.ownerId,adapter);
    }
    const result=Object.freeze({vaultId:body.vault.id,createdAt:manifest.createdAt,records:body.envelopes.filter(e=>e.lane!=='assets').length,assets:manifest.assets,pending:manifest.pending});
    const data:StoredVault={descriptor:body.vault,keyBundles:body.keyBundles as KeyBundle[],envelopes:body.envelopes,outbox:body.outbox,cursors:{directory:'0',records:'0'},complete:{directory:false,records:false}};
    validated.set(result,data);return result;
  }finally{for(const item of keys.values())item.raw.fill(0);keys.clear();}
}
export function getPreviewData(preview:BackupPreview):StoredVault{const data=validated.get(preview);if(!data)throw new Error('BACKUP_PREVIEW_REQUIRED');return data;}
export { base64 };

function validatePayload<T extends VaultRecord>(payload:unknown,envelope:CipherEnvelope,ownerId:string,adapter:RecordAdapter<T>):void{
  if(envelope.tombstone){
    const deleted=z.strictObject({id:opaqueId,kind:z.literal('deleted'),previousKind:z.string().min(1)}).parse(payload);
    if(deleted.id!==envelope.recordId)throw new Error('BACKUP_TOMBSTONE_ROUTING');return;
  }
  const record=adapter.parse(payload);
  if(record.id!==envelope.recordId || record.ownerId!==ownerId || adapter.lane(record)!==envelope.lane)throw new Error('BACKUP_ENTITY_ROUTING');
}
