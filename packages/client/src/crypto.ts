import { z } from 'zod';
import { aad, envelopeSchema, opaqueId, type CipherEnvelope } from '@zhijiao/shared';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const KDF_ITERATIONS = 600_000;
export const MAX_KDF_ITERATIONS = 2_000_000;
export function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
export function base64(bytes: Uint8Array): string {
  let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export function unbase64(value: string, size?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('INVALID_BASE64');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if ((size !== undefined && bytes.length !== size) || base64(bytes) !== value) throw new Error('INVALID_BASE64');
  return bytes;
}
const b64 = (bytes: number) => z.string().max(Math.ceil(bytes / 3) * 4).refine(v => { try { unbase64(v, bytes); return true; } catch { return false; } });
export const wrappedKeySchema = z.strictObject({ nonce: b64(12), ciphertext: b64(48) });
export type WrappedKey = z.infer<typeof wrappedKeySchema>;
const previousKeySchema = wrappedKeySchema.extend({keyVersion:z.number().int().min(1).max(1_000_000)});
export const keyBundleSchema = z.strictObject({
  formatVersion: z.literal(1), vaultId: opaqueId, keyVersion: z.number().int().min(1).max(1_000_000),
  kdf: z.strictObject({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int().min(KDF_ITERATIONS).max(MAX_KDF_ITERATIONS), salt: b64(16) }),
  passphrase: wrappedKeySchema, recovery: wrappedKeySchema, createdAt: z.iso.datetime(),
  previousKeys:z.array(previousKeySchema).max(1000).optional()
}).refine(bundle=>!bundle.previousKeys || (new Set(bundle.previousKeys.map(k=>k.keyVersion)).size===bundle.previousKeys.length && bundle.previousKeys.every(k=>k.keyVersion<bundle.keyVersion)), 'INVALID_PREVIOUS_KEY_VERSIONS');
export type KeyBundle = z.infer<typeof keyBundleSchema>;
export const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
export const importAesKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
export async function encryptBytes(key: CryptoKey, bytes: Uint8Array, authenticated: string): Promise<{nonce: string; ciphertext: string}> {
  const nonce = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(encoder.encode(authenticated)), tagLength: 128 }, key, buffer(bytes));
  return { nonce: base64(nonce), ciphertext: base64(new Uint8Array(encrypted)) };
}
export async function decryptBytes(key: CryptoKey, encrypted: {nonce: string; ciphertext: string}, authenticated: string): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(unbase64(encrypted.nonce, 12)), additionalData: buffer(encoder.encode(authenticated)), tagLength: 128 }, key, buffer(unbase64(encrypted.ciphertext)));
  return new Uint8Array(plain);
}
export function jsonBytes(value: unknown): Uint8Array { return encoder.encode(JSON.stringify(value)); }
export function parseBytes(bytes: Uint8Array): unknown { return JSON.parse(decoder.decode(bytes)); }
async function wrappingKey(passphrase: string, kdf: KeyBundle['kdf']): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('PASSPHRASE_LENGTH_12_TO_1024');
  // Validate before any expensive derivation, including attacker-controlled backup parameters.
  keyBundleSchema.shape.kdf.parse(kdf);
  const encoded = encoder.encode(passphrase);
  const material = await crypto.subtle.importKey('raw', buffer(encoded), 'PBKDF2', false, ['deriveKey']); encoded.fill(0);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: kdf.hash, salt: buffer(unbase64(kdf.salt, 16)), iterations: kdf.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}
function keyAad(bundle: Pick<KeyBundle,'vaultId'|'keyVersion'|'formatVersion'|'kdf'|'createdAt'>, method: 'passphrase'|'recovery'): string {
  return JSON.stringify(['zhijiao-key',bundle.vaultId,bundle.keyVersion,bundle.formatVersion,method,method === 'passphrase' ? bundle.kdf : null,bundle.createdAt]);
}
export function newRecoverySecret(): string { return `ZJ1-${base64(randomBytes(32)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}`; }
function recoveryBytes(secret: string): Uint8Array {
  if (!/^ZJ1-[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('INVALID_RECOVERY_SECRET');
  return unbase64(secret.slice(4).replaceAll('-','+').replaceAll('_','/') + '=', 32);
}
export function previousKeyAad(bundle:Pick<KeyBundle,'vaultId'|'keyVersion'|'formatVersion'|'createdAt'>,oldVersion:number):string {
  return JSON.stringify(['zhijiao-previous-key',bundle.vaultId,bundle.keyVersion,oldVersion,bundle.formatVersion,bundle.createdAt]);
}
export async function createKeyBundle(vaultId: string, passphrase: string, raw = randomBytes(32), recoverySecret = newRecoverySecret(), keyVersion = 1, previousRawKeys?:Map<number,Uint8Array>): Promise<{bundle: KeyBundle; raw: Uint8Array; key: CryptoKey; recoverySecret: string}> {
  let recoveryRaw:Uint8Array|undefined;
  try {
    if (raw.length !== 32) throw new Error('INVALID_KEY_LENGTH');opaqueId.parse(vaultId);
    const header = { formatVersion: 1 as const, vaultId, keyVersion, kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: KDF_ITERATIONS, salt: base64(randomBytes(16)) }, createdAt: new Date().toISOString() };
    const kek = await wrappingKey(passphrase, header.kdf);recoveryRaw=recoveryBytes(recoverySecret);
    const recoveryKey = await importAesKey(recoveryRaw),key=await importAesKey(raw);
    if(previousRawKeys && (previousRawKeys.size>1000 || [...previousRawKeys].some(([version,bytes])=>version>=keyVersion || bytes.length!==32)))throw new Error('INVALID_PREVIOUS_KEYS');
    const previousKeys=[];for(const [oldVersion,oldRaw] of previousRawKeys??[])previousKeys.push({keyVersion:oldVersion,...await encryptBytes(key,oldRaw,previousKeyAad(header,oldVersion))});
    const bundle = keyBundleSchema.parse({ ...header, passphrase: await encryptBytes(kek, raw, keyAad(header,'passphrase')), recovery: await encryptBytes(recoveryKey, raw, keyAad(header,'recovery')), ...(previousKeys.length?{previousKeys}: {}) });
    return { bundle, raw, key, recoverySecret };
  } catch(error) {raw.fill(0);throw error;} finally { recoveryRaw?.fill(0); }
}
export async function unwrapPreviousKeys(bundle:KeyBundle,key:CryptoKey):Promise<Map<number,{raw:Uint8Array;key:CryptoKey}>> {
  const previous=new Map<number,{raw:Uint8Array;key:CryptoKey}>();
  try {
    for(const wrapped of keyBundleSchema.parse(bundle).previousKeys??[]) {
      const raw=await decryptBytes(key,wrapped,previousKeyAad(bundle,wrapped.keyVersion));
      if(raw.length!==32){raw.fill(0);throw new Error('INVALID_PREVIOUS_KEY_LENGTH');}
      previous.set(wrapped.keyVersion,{raw,key:await importAesKey(raw)});
    }
    return previous;
  }catch(error){for(const item of previous.values())item.raw.fill(0);throw error;}
}
export async function unwrapKeyBundle(input: unknown, secret: string, recovery = false): Promise<{bundle: KeyBundle; raw: Uint8Array; key: CryptoKey}> {
  const bundle = keyBundleSchema.parse(input);
  let recoveryRaw: Uint8Array | undefined;
  try {
    const kek = recovery ? await importAesKey(recoveryRaw = recoveryBytes(secret)) : await wrappingKey(secret,bundle.kdf);
    const raw = await decryptBytes(kek, recovery ? bundle.recovery : bundle.passphrase, keyAad(bundle, recovery ? 'recovery' : 'passphrase'));
    if (raw.length !== 32) { raw.fill(0); throw new Error('INVALID_KEY_LENGTH'); }
    return { bundle, raw, key: await importAesKey(raw) };
  } finally { recoveryRaw?.fill(0); }
}
export async function rewrapKeyBundle(old: KeyBundle, raw: Uint8Array, passphrase: string): Promise<KeyBundle> {
  const header = { ...old, kdf: { ...old.kdf, iterations: KDF_ITERATIONS, salt: base64(randomBytes(16)) } };
  // Preserve recovery AAD and recovery ciphertext; passphrase change does not revoke saved recovery secrets.
  return keyBundleSchema.parse({ ...header, passphrase: await encryptBytes(await wrappingKey(passphrase,header.kdf),raw,keyAad(header,'passphrase')) });
}
export async function encryptEnvelope(key: CryptoKey, header: Omit<CipherEnvelope,'nonce'|'ciphertext'>, payload: unknown): Promise<CipherEnvelope> {
  return envelopeSchema.parse({ ...header, ...await encryptBytes(key,jsonBytes(payload),aad(header)) });
}
export async function decryptEnvelope(key: CryptoKey, input: CipherEnvelope): Promise<unknown> {
  const envelope = envelopeSchema.parse(input);
  const bytes = await decryptBytes(key,envelope,aad(envelope));
  try { return parseBytes(bytes); } finally { bytes.fill(0); }
}
export async function sha256(value: unknown): Promise<string> { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(jsonBytes(value))))); }
export async function directoryId(personId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(encoder.encode(`zhijiao-directory:${personId}`))));
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes.subarray(0,16), v => v.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
