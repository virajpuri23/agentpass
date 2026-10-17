import { randomBytes } from 'node:crypto';
import type { AuthorityStore } from '../../../db/store.js';

export interface CredentialStore {
  ensure(reference:string):Promise<string>;
  read(reference:string):Promise<string>;
  remove(reference:string):Promise<void>;
}
const credential = (value:unknown) => {
  if(typeof value!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(value))throw new Error('Private credential unavailable');
  return value;
};

// Requires a dedicated backend connection; Vault privileges are a deployment gate.
export function vaultCredentialStore(db:AuthorityStore):CredentialStore {
  return {
    ensure:reference=>db.transaction(async()=>{
      const existing=await db.prepare('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=?').get(reference);
      if(existing)return credential(existing.decrypted_secret);
      const secret=randomBytes(32).toString('base64url');
      await db.prepare('SELECT vault.create_secret(?,?,?)').get(secret,reference,'AgentPass private child credential');
      return secret;
    }).immediate(),
    async read(reference){return credential((await db.prepare('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=?').get(reference))?.decrypted_secret);},
    async remove(reference){await db.prepare('DELETE FROM vault.secrets WHERE name=?').run(reference);},
  };
}
