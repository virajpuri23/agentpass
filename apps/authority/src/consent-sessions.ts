import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';
import type { AuthorityStore } from '../../../db/store.js';

export class ConsentSessions {
  constructor(private db:AuthorityStore,private key:Buffer,private now=()=>new Date()){
    if(key.length!==32)throw new Error('Consent session key must be 256 bits');
  }
  private hash(id:string){return createHash('sha256').update(id).digest('hex');}
  async save(id:string,data:Record<string,unknown>){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(this.hash(id)));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
    const payload=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
    await this.db.prepare('DELETE FROM consent_sessions WHERE expires_at<=?').run(this.now().toISOString());
    await this.db.prepare('INSERT INTO consent_sessions(id_hash,payload_ciphertext,expires_at) VALUES(?,?,?) ON CONFLICT(id_hash) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,expires_at=excluded.expires_at').run(this.hash(id),payload,new Date(this.now().getTime()+300000).toISOString());
  }
  async create(data:Record<string,unknown>){const id=randomBytes(32).toString('base64url');await this.save(id,data);return id;}
  async read(id:string){
    if(!/^[A-Za-z0-9_-]{43}$/.test(id))return null;
    const row=await this.db.prepare('SELECT payload_ciphertext FROM consent_sessions WHERE id_hash=? AND expires_at>?').get(this.hash(id),this.now().toISOString());
    if(!row)return null;
    const bytes=Buffer.from(row.payload_ciphertext,'base64url');const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(this.hash(id)));decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as Record<string,unknown>;
  }
  async remove(id:string){await this.db.prepare('DELETE FROM consent_sessions WHERE id_hash=?').run(this.hash(id));}
  async consume(id:string){return this.db.transaction(async()=>{const session=await this.read(id);if(session)await this.remove(id);return session;}).immediate();}
}
