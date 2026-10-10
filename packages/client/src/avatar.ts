import type { AvatarRef, CipherEnvelope } from '@zhijiao/shared';
import { aad } from '@zhijiao/shared';
import { base64, buffer, decryptBytes, encryptBytes, importAesKey, randomBytes, unbase64, wrappedKeySchema, type WrappedKey } from './crypto.js';

export interface PreparedAvatar { main: Uint8Array; thumb: Uint8Array }
export interface AvatarCrop { x: number; y: number; size: number }
export interface AvatarHandle { url: string; release(): void }
const signature = [137,80,78,71,13,10,26,10];
function uint32(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset); }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Reject animation, unknown chunks and metadata; only raster data is uploaded. */
export function validateAvatarPng(bytes: Uint8Array, expectedSize?: number): {width:number;height:number} {
  if (bytes.length > 4_000_000 || bytes.length < 45 || !signature.every((b,i)=>bytes[i]===b)) throw new Error('INVALID_AVATAR_PNG');
  let offset=8, width=0,height=0, ended=false, data=false, sawHeader=false;
  while (offset < bytes.length) {
    if (offset+12 > bytes.length) throw new Error('INVALID_PNG_LENGTH');
    const size=uint32(bytes,offset); if (size>4_000_000 || offset+size+12>bytes.length) throw new Error('INVALID_PNG_LENGTH');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if (!['IHDR','IDAT','IEND'].includes(type)) throw new Error('AVATAR_METADATA_OR_UNSUPPORTED_CHUNK');
    if (crc32(bytes.subarray(offset+4,offset+size+8))!==uint32(bytes,offset+size+8)) throw new Error('INVALID_PNG_CRC');
    if (type==='IHDR') {
      if (sawHeader || offset!==8 || size!==13) throw new Error('INVALID_PNG_HEADER');
      sawHeader=true; width=uint32(bytes,offset+8);height=uint32(bytes,offset+12);
      if (width!==height || ![128,512].includes(width) || (expectedSize && width!==expectedSize)) throw new Error('INVALID_AVATAR_DIMENSIONS');
      if (bytes[offset+16]!==8 || ![2,6].includes(bytes[offset+17]!) || bytes[offset+18]!==0 || bytes[offset+19]!==0 || bytes[offset+20]!==0) throw new Error('INVALID_PNG_ENCODING');
    } else if (type==='IDAT') { if (!sawHeader || ended) throw new Error('INVALID_PNG_ORDER');data=true; }
    else { if (size!==0 || !data || !sawHeader) throw new Error('INVALID_PNG_END'); ended=true; }
    offset+=size+12; if (ended && offset!==bytes.length) throw new Error('PNG_TRAILING_BYTES');
  }
  if (!ended) throw new Error('INCOMPLETE_PNG'); return {width,height};
}
function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (!signature.every((b,i)=>bytes[i]===b)) throw new Error('CANVAS_PNG_REQUIRED');
  const chunks=[bytes.subarray(0,8)]; let offset=8;
  while (offset<bytes.length) {
    if (offset+12>bytes.length) throw new Error('INVALID_PNG_LENGTH');
    const size=uint32(bytes,offset); if (offset+size+12>bytes.length) throw new Error('INVALID_PNG_LENGTH');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if (['IHDR','IDAT','IEND'].includes(type)) chunks.push(bytes.subarray(offset,offset+size+12));
    else if (!/^[a-z]/.test(type)) throw new Error('UNSUPPORTED_CRITICAL_PNG_CHUNK');
    offset+=size+12;
  }
  const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0)); let index=0;
  for (const c of chunks) {result.set(c,index);index+=c.length;}
  validateAvatarPng(result);return result;
}
export function avatarCropRect(width:number,height:number,crop?:AvatarCrop):{x:number;y:number;size:number} {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('INVALID_IMAGE_DIMENSIONS');
  const edge=Math.min(width,height);
  if(!crop)return {x:(width-edge)/2,y:(height-edge)/2,size:edge};
  if(!Object.values(crop).every(Number.isFinite)||crop.x<0||crop.y<0||crop.size<=0 || (crop.x+crop.size)*edge>width+0.000001 || (crop.y+crop.size)*edge>height+0.000001)throw new Error('INVALID_CROP');
  const size=Math.min(edge,crop.size*edge);
  return {x:Math.min(crop.x*edge,width-size),y:Math.min(crop.y*edge,height-size),size};
}
export async function prepareAvatar(file: Blob, crop?: AvatarCrop): Promise<PreparedAvatar> {
  if (file.size>20_000_000 || file.size===0 || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('AVATAR_INPUT_JPEG_PNG_WEBP_MAX_20MB');
  if (crop && (!Object.values(crop).every(Number.isFinite) || crop.x<0 || crop.y<0 || crop.size<=0)) throw new Error('INVALID_CROP');
  // Browser decodes EXIF orientation before cropping. The source is never uploaded.
  const image=await createImageBitmap(file,{imageOrientation:'from-image'});
  try {
    if (image.width*image.height>50_000_000) throw new Error('AVATAR_INPUT_TOO_MANY_PIXELS');
    const source=avatarCropRect(image.width,image.height,crop);
    const render=async(size:number) => {
      const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
      try {
        const context=canvas.getContext('2d'); if (!context) throw new Error('CANVAS_UNAVAILABLE');
        context.drawImage(image,source.x,source.y,source.size,source.size,0,0,size,size);
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('AVATAR_ENCODE_FAILED')),'image/png'));
        const bytes=stripMetadata(new Uint8Array(await blob.arrayBuffer()));validateAvatarPng(bytes,size);return bytes;
      } finally {canvas.width=0;canvas.height=0;}
    };
    return {main:await render(512),thumb:await render(128)};
  } finally {image.close();}
}
export function assetKeyAad(vaultId:string,id:string,revision:string,variant:'main'|'thumb',keyVersion:number):string {
  return JSON.stringify(['zhijiao-asset-key',vaultId,id,revision,variant,keyVersion]);
}
export async function encryptAvatarAsset(vaultKey:CryptoKey,vaultId:string,keyVersion:number,variant:'main'|'thumb',bytes:Uint8Array):Promise<{envelope:CipherEnvelope;reference:AvatarRef['main']}> {
  validateAvatarPng(bytes,variant==='main'?512:128);
  const id=crypto.randomUUID(), revision='1', raw=randomBytes(32);
  try {
    const key=await importAesKey(raw);
    const header={vaultId,recordId:id,revision,keyVersion,formatVersion:1 as const,lane:'assets' as const,tombstone:false,variant};
    const keyEnvelope=await encryptBytes(vaultKey,raw,assetKeyAad(vaultId,id,revision,variant,keyVersion));
    return {envelope:{...header,...await encryptBytes(key,bytes,aad(header))},reference:{id,revision,keyEnvelope}};
  } finally {raw.fill(0);}
}
export async function decryptAvatarAsset(vaultKey:CryptoKey,vaultId:string,keyVersion:number,ref:AvatarRef['main'],variant:'main'|'thumb',envelope:CipherEnvelope):Promise<Uint8Array> {
    if (envelope.vaultId!==vaultId || envelope.recordId!==ref.id || envelope.revision!==ref.revision || envelope.lane!=='assets' || envelope.variant!==variant || envelope.tombstone) throw new Error('ASSET_ROUTING_MISMATCH');
  const keyEnvelope=wrappedKeySchema.parse(ref.keyEnvelope);
  const raw=await decryptBytes(vaultKey,keyEnvelope,assetKeyAad(vaultId,ref.id,ref.revision,variant,keyVersion));
  try {
    if (raw.length!==32) throw new Error('INVALID_ASSET_KEY_LENGTH');
    const bytes=await decryptBytes(await importAesKey(raw),envelope,aad(envelope));
    try {validateAvatarPng(bytes,variant==='main'?512:128);return bytes;} catch (e) {bytes.fill(0);throw e;}
  } finally {raw.fill(0);}
}
interface CacheEntry {url:string;bytes:number;refs:number;used:number}
export interface AssetCacheContext {
  lease(): {vaultId:string;generation:number;signal:AbortSignal};
  check(generation:number):void;
  key(version:number):CryptoKey;
  load(id:string,revision:string,signal:AbortSignal):Promise<CipherEnvelope>;
}
/** Shared session Blob cache. Component release only drops a reference; lock always revokes. */
export class AvatarCache {
  private entries=new Map<string,CacheEntry>(); private inFlight=new Map<string,Promise<CacheEntry>>();
  private active=0; private waiters:Array<()=>void>=[];
  constructor(private readonly context:AssetCacheContext,private readonly maxBytes=16_000_000,private readonly maxEntries=80,private readonly concurrency=3) {}
  clear():void { for(const e of this.entries.values()) URL.revokeObjectURL(e.url);this.entries.clear();this.inFlight.clear();for(const wake of this.waiters.splice(0))wake(); }
  private evict(extra:number):void {
    let used=[...this.entries.values()].reduce((n,e)=>n+e.bytes,0);
    for(const [key,e] of [...this.entries].filter(([,e])=>e.refs===0).sort((a,b)=>a[1].used-b[1].used)) {
      if(used+extra<=this.maxBytes && this.entries.size<this.maxEntries)break;
      URL.revokeObjectURL(e.url);this.entries.delete(key);used-=e.bytes;
    }
    if(used+extra>this.maxBytes || this.entries.size>=this.maxEntries)throw new Error('AVATAR_CACHE_CAPACITY');
  }
  async acquire(ref:AvatarRef,variant:'main'|'thumb'='thumb'):Promise<AvatarHandle> {
    const lease=this.context.lease(), target=ref[variant];
    const cacheKey=`${lease.vaultId}/${target.id}/${target.revision}/${variant}`;
    let entry=this.entries.get(cacheKey);
    if (!entry) {
      let pending=this.inFlight.get(cacheKey);
      if(!pending) {
        pending=(async()=>{
          while(this.active>=this.concurrency) {await new Promise<void>(resolve=>this.waiters.push(resolve));this.context.check(lease.generation);}
          this.context.check(lease.generation);this.active++;
          try {
            const envelope=await this.context.load(target.id,target.revision,lease.signal);this.context.check(lease.generation);
            const bytes=await decryptAvatarAsset(this.context.key(ref.keyVersion),lease.vaultId,ref.keyVersion,target,variant,envelope);
            try {
              this.context.check(lease.generation);this.evict(bytes.length);
              const result={url:URL.createObjectURL(new Blob([buffer(bytes)],{type:'image/png'})),bytes:bytes.length,refs:1,used:Date.now()};
              // Pin until all promise continuations can acquire their references; a sibling request must not evict the handoff.
              setTimeout(()=>{result.refs=Math.max(0,result.refs-1);},0);
              this.entries.set(cacheKey,result);return result;
            } finally {bytes.fill(0);}
          } finally {this.active--;this.waiters.shift()?.();}
        })();
        this.inFlight.set(cacheKey,pending);
        void pending.finally(()=>{if(this.inFlight.get(cacheKey)===pending)this.inFlight.delete(cacheKey);}).catch(()=>{});
      }
      entry=await pending;
    }
    this.context.check(lease.generation);entry.refs++;entry.used=Date.now();
    let released=false;
    return {url:entry.url,release:()=>{if(released)return;released=true;entry!.refs=Math.max(0,entry!.refs-1);entry!.used=Date.now();}};
  }
}
export type AssetKeyEnvelope = WrappedKey;
export { base64, unbase64 };
