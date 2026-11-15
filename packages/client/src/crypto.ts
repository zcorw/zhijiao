export * from '@zcorw/encrypted-vault/crypto';
import { scopedRecordId } from '@zcorw/encrypted-vault/crypto';
export function directoryId(personId:string):Promise<string>{return scopedRecordId(`zhijiao-directory:${personId}`);}
export function ownerPersonId(vaultId:string):Promise<string>{return scopedRecordId(`zhijiao-self:${vaultId}`);}
