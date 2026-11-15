export * from '@zcorw/encrypted-vault/storage';
import { IndexedDbStore as EncryptedIndexedDbStore } from '@zcorw/encrypted-vault/storage';
/** Keep the existing database name; independent apps select their own namespace. */
export class IndexedDbStore extends EncryptedIndexedDbStore {
  constructor(name='zhijiao-encrypted-v1'){super(name);}
}
