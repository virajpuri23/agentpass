import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../src/app.js';
import { AuthorityEngine } from '../src/engine.js';
import { sqliteStore } from '../../../db/store.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import type { SupplierService } from '../src/supplier.js';
const keys={'owner-1':'provision-owner','buyer-agent':'provision-buyer','sourcing-agent':'provision-source','supplier-agent':'provision-supplier'};
const secret='private-child-fixture-token';const hash=createHash('sha256').update(secret).digest('hex');
const supplier:SupplierService={policy:async()=>true,quote:async()=>{throw new Error();},getQuote:async()=>{throw new Error();},fulfill:async()=>{throw new Error();}};

describe('trusted child provisioning',()=>{
  let db:ReturnType<typeof openDatabase>,server:Server,base:string,now:Date;
  const scope=():AuthorityScope=>({actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:new Date(now.getTime()+3600000).toISOString(),max_delegation_depth:0});
  const body=()=>({scope:scope(),credential_hash:hash,idempotency_key:'provision-fixture'});
  async function call(path:string,body?:unknown,token=keys['buyer-agent']){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {http:r.status,...await r.json()};}
  async function provision(input:unknown=body(),token=keys['buyer-agent'],parent='grant-root-buyer'){return call(`/v1/grants/${parent}/provision-child`,input,token);}
  function counts(){return ['principals','principal_keys','grants','child_provisionings'].map(t=>(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);}
  beforeEach(async()=>{now=new Date('2026-10-17T22:00:00Z');db=openDatabase(':memory:');seedDatabase(db,keys,now);server=createAuthorityApp({db,supplier,now:()=>now}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as any).port}`;});
  afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
  it('atomically creates a distinct child, authenticates its own key, and never exposes credential material',async()=>{
    const result=await provision();expect(result.status).toBe('OK');expect(result.data.principal).toMatchObject({kind:'AGENT',role:'SERVICE',organization_id:'buyer-co'});expect(result.data.principal.id).not.toBe('buyer-agent');
    expect(result.data.grant).toMatchObject({subject_principal_id:result.data.principal.id,issuer_principal_id:'buyer-agent',parent_grant_id:'grant-root-buyer',scope:scope()});expect(counts()).toEqual([5,5,2,1]);
    expect((await call('/v1/me',undefined,secret)).data.principal_id).toBe(result.data.principal.id);expect((await call('/v1/me',undefined,hash)).http).toBe(401);
    expect(JSON.stringify(result)).not.toContain(hash);expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(db.prepare('SELECT * FROM audit_events').all())).not.toContain(secret);
    expect((await call('/v1/audit',undefined,secret)).http).toBe(403);
  });
  it('serializes concurrent identical retries and rejects idempotency rebinding without new identities',async()=>{
    const input=body();const [a,b]=await Promise.all([provision(input),provision(input)]);expect(a.data).toEqual(b.data);expect(counts()).toEqual([5,5,2,1]);
    expect((await provision({...input,scope:{...input.scope,sku_ids:[]}})).code).toBe('ALREADY_EXECUTED');expect(counts()).toEqual([5,5,2,1]);
  });
  it('does not let a different principal or organization spend the parent authority',async()=>{
    for(const token of [keys['owner-1'],keys['sourcing-agent'],keys['supplier-agent'],'unknown'])expect((await provision(body(),token)).status).not.toBe('OK');expect(counts()).toEqual([4,4,1,0]);
  });
  it('rejects caller-selected identity, role, organization and raw credentials',async()=>{
    for(const extra of [{principal_id:'owner-1'},{role:'OWNER'},{organization_id:'supplier-co'},{credential:secret}])expect((await provision({...body(),...extra})).http).toBe(400);
    expect((await provision({...body(),credential_hash:secret})).http).toBe(400);expect(counts()).toEqual([4,4,1,0]);
  });
  it('rejects widening in each scope dimension and exhausted delegation depth',async()=>{
    const widenings=[{actions:['supplier.margin.read']},{supplier_ids:['other']},{sku_ids:['other']},{total_budget_cents:100001},{max_per_action_cents:100001},{expires_at:new Date(now.getTime()+172800000).toISOString()},{max_delegation_depth:2}];
    for(const widened of widenings)expect((await provision({...body(),scope:{...scope(),...widened}})).code).toBe('OUTSIDE_PARENT_SCOPE');
    const parent=(await provision()).data.grant;expect((await provision({...body(),credential_hash:createHash('sha256').update('grandchild').digest('hex')},secret,parent.id)).code).toBe('OUTSIDE_PARENT_SCOPE');expect(counts()).toEqual([5,5,2,1]);
  });
  it('rejects limits beyond remaining ancestor budget and never rebinds an existing credential',async()=>{
    db.prepare("INSERT INTO purchases(id,caller_principal_id,grant_id,quote_id,idempotency_key,request_json,amount_cents,status,created_at,updated_at) VALUES('reserved','buyer-agent','grant-root-buyer','fixture','fixture','{}',95000,'PENDING',?,?)").run(now.toISOString(),now.toISOString());
    db.prepare("INSERT INTO ledger_entries(id,purchase_id,grant_id,amount_cents,state,created_at) VALUES('reserved','reserved','grant-root-buyer',95000,'RESERVED',?)").run(now.toISOString());
    expect((await provision({...body(),scope:{...scope(),total_budget_cents:6000,max_per_action_cents:6000}})).code).toBe('BUDGET_EXCEEDED');
    expect((await provision({...body(),credential_hash:createHash('sha256').update(keys['buyer-agent']).digest('hex')})).code).toBe('INVALID_REQUEST');expect(counts()).toEqual([4,4,1,0]);
  });
  it('binds child authentication and replay to direct or ancestor revocation and expiry',async()=>{
    const result=await provision();await call(`/v1/grants/${result.data.grant.id}/revoke`,{reason:'stop child'});
    expect((await call('/v1/me',undefined,secret)).http).toBe(401);expect((await provision()).code).toBe('GRANT_REVOKED');
    const other=await provision({...body(),credential_hash:createHash('sha256').update('other-child').digest('hex'),idempotency_key:'other'});expect(other.status).toBe('OK');
    now=new Date(now.getTime()+3600001);expect((await call('/v1/me',undefined,'other-child')).http).toBe(401);
    const future=await provision({...body(),credential_hash:createHash('sha256').update('future-child').digest('hex'),idempotency_key:'future'});expect(future.status).toBe('OK');
    await call('/v1/grants/grant-root-buyer/revoke',{reason:'stop family'},keys['owner-1']);expect((await call('/v1/me',undefined,'future-child')).http).toBe(401);
  });
  it('refuses already-expired child scope and revoked or expired parent authority without creating records',async()=>{
    expect((await provision({...body(),scope:{...scope(),expires_at:new Date(now.getTime()-1000).toISOString()}})).code).toBe('GRANT_EXPIRED');expect(counts()).toEqual([4,4,1,0]);
    db.prepare('UPDATE grants SET revoked_at=? WHERE id=?').run(now.toISOString(),'grant-root-buyer');expect((await provision()).code).toBe('GRANT_REVOKED');
    db.prepare('UPDATE grants SET revoked_at=NULL WHERE id=?').run('grant-root-buyer');now=new Date(now.getTime()+172800000);expect((await provision()).code).toBe('GRANT_EXPIRED');expect(counts()).toEqual([4,4,1,0]);
  });
  it('fails authentication closed for inactive children, revoked keys and unavailable provisioning storage',async()=>{
    const child=(await provision()).data.principal.id;
    db.prepare('UPDATE principals SET active=0 WHERE id=?').run(child);expect((await call('/v1/me',undefined,secret)).http).toBe(401);
    db.prepare('UPDATE principals SET active=1 WHERE id=?').run(child);db.prepare('UPDATE principal_keys SET revoked_at=? WHERE principal_id=?').run(now.toISOString(),child);expect((await call('/v1/me',undefined,secret)).http).toBe(401);
    db.prepare('UPDATE principal_keys SET revoked_at=NULL WHERE principal_id=?').run(child);db.exec('DROP TABLE child_provisionings');expect(await call('/v1/me',undefined,secret)).toMatchObject({http:503,code:'SERVICE_UNAVAILABLE'});
  });
  it('rolls back all child records if persistence fails after issuance',async()=>{
    const baseStore=sqliteStore(db);const failing={...baseStore,prepare(sql:string){if(sql.startsWith('INSERT INTO child_provisionings'))return {get:async()=>undefined,all:async()=>[],run:async()=>{throw new Error('write failed');}};return baseStore.prepare(sql);}};
    const engine=new AuthorityEngine(failing,supplier,()=>now);const parent=await engine.authenticate(keys['buyer-agent']);
    await expect(engine.provisionChild(parent,'grant-root-buyer',scope(),hash,'rollback')).rejects.toThrow('write failed');expect(counts()).toEqual([4,4,1,0]);expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({n:0});
  });
});
