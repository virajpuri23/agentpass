import { randomUUID } from 'node:crypto';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { AccountService } from './accounts.js';
import { AuthorityEngine,deny } from './engine.js';
import { scopeSchema } from './validation.js';

export class ConsentService {
  constructor(private engine:AuthorityEngine,private policy:()=>AuthorityScope,private now=()=>new Date()){}
  private async binding(connectionId:string,accountId:string){
    const row=await this.engine.db.prepare('SELECT principal_id FROM assistant_connections WHERE id=?').get(connectionId);
    if(!row)deny('INVALID_CALLER','Connection unavailable',403);
    const connection=await new AccountService(this.engine.db,this.now).connectionForPrincipal(row.principal_id);
    if(!connection||connection.account_id!==accountId||connection.state==='REVOKED'||connection.account_state!=='ACTIVE'||connection.membership_state!=='ACTIVE'||!connection.principal_active)deny('INVALID_CALLER','Connection unavailable',403);
    const membership=await this.engine.db.prepare("SELECT human_principal_id FROM memberships WHERE id=? AND role='OWNER' AND state='ACTIVE'").get(connection.membership_id);
    if(!membership)deny('INVALID_CALLER','Owner consent required',403);
    return {...connection,human_principal_id:membership.human_principal_id};
  }
  private validate(scope:AuthorityScope){
    const parsed=scopeSchema.parse(scope);this.engine.subset(parsed,scopeSchema.parse(this.policy()),false);
    if(Date.parse(parsed.expires_at)<=this.now().getTime())deny('GRANT_EXPIRED','Consent scope expired');
    return parsed;
  }
  async request(accountId:string,connectionId:string,scope:AuthorityScope){
    return this.engine.db.transaction(async()=>{
      const connection=await this.binding(connectionId,accountId);if(connection.state!=='CONSENT_REQUIRED')deny('ALREADY_EXECUTED','Connection already has an allocation',409);
      const normalized=this.validate(scope),id=randomUUID(),created=this.now().toISOString(),expires=new Date(this.now().getTime()+300000).toISOString();
      await this.engine.db.prepare('INSERT INTO consent_requests(id,connection_id,scope_json,created_at,expires_at,consumed_at) VALUES(?,?,?,?,?,NULL)').run(id,connectionId,JSON.stringify(normalized),created,expires);
      return {id,connection_id:connectionId,scope:normalized,expires_at:expires};
    }).immediate();
  }
  async approve(accountId:string,requestId:string){
    return this.engine.db.transaction(async()=>{
      const request=await this.engine.db.prepare('SELECT * FROM consent_requests WHERE id=?').get(requestId);
      if(!request)deny('INVALID_CALLER','Consent request unavailable',403);
      const connection=await this.binding(request.connection_id,accountId);
      const previous=await this.engine.db.prepare('SELECT grant_id FROM consent_approvals WHERE id=? AND connection_id=?').get(requestId,connection.id);
      if(previous){await this.engine.chain(previous.grant_id,await this.engine.principal(connection.principal_id));return this.engine.grant(previous.grant_id);}
      if(request.consumed_at||Date.parse(request.expires_at)<=this.now().getTime())deny('GRANT_EXPIRED','Consent request expired or already consumed');
      if(connection.state!=='CONSENT_REQUIRED'||connection.grant_id)deny('ALREADY_EXECUTED','Connection already has an allocation',409);
      const scope=this.validate(JSON.parse(request.scope_json)),id=randomUUID(),time=this.now().toISOString();
      const human=await this.engine.principal(connection.human_principal_id);
      if(human.kind!=='HUMAN'||human.role!=='OWNER'||human.organization_id!==connection.organization_id)deny('INVALID_CALLER','Owner membership unavailable');
      await this.engine.db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,NULL,?,?,?,?)').run(id,connection.organization_id,human.id,connection.principal_id,JSON.stringify(scope),time);
      await this.engine.db.prepare('INSERT INTO consent_approvals(id,connection_id,human_principal_id,scope_json,grant_id,approved_at) VALUES(?,?,?,?,?,?)').run(requestId,connection.id,human.id,JSON.stringify(scope),id,time);
      await this.engine.db.prepare("UPDATE assistant_connections SET state='ACTIVE',grant_id=? WHERE id=?").run(id,connection.id);
      await this.engine.db.prepare('UPDATE consent_requests SET consumed_at=? WHERE id=?').run(time,requestId);
      await this.engine.audit(human,'connection.consent','ALLOW',id,undefined,requestId);
      return this.engine.grant(id);
    }).immediate();
  }
  async revoke(accountId:string,connectionId:string){
    return this.engine.db.transaction(async()=>{
      const raw=await this.engine.db.prepare('SELECT * FROM assistant_connections WHERE id=? AND account_id=?').get(connectionId,accountId);
      if(!raw)deny('INVALID_CALLER','Connection unavailable',403);
      if(raw.state==='REVOKED')return {connection_id:connectionId,state:'REVOKED' as const};
      const connection=await this.binding(connectionId,accountId),time=this.now().toISOString();
      if(connection.grant_id)await this.engine.db.prepare('UPDATE grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(time,connection.grant_id);
      await this.engine.db.prepare("UPDATE assistant_connections SET state='REVOKED',revoked_at=? WHERE id=?").run(time,connectionId);
      await this.engine.db.prepare('UPDATE principals SET active=0 WHERE id=?').run(connection.principal_id);
      await this.engine.audit(await this.engine.principal(connection.human_principal_id),'connection.revoke','ALLOW',connection.grant_id??undefined);
      return {connection_id:connectionId,state:'REVOKED' as const};
    }).immediate();
  }
}
