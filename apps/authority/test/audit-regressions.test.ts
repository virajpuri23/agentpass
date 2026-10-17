import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../src/app.js';
import { HttpSupplierService } from '../src/supplier.js';

let directory: string, db: ReturnType<typeof openDatabase>, sellerDb: Database.Database;
let authority: Server, seller: Server, base: string, now: Date;
let fulfillmentCalls: number;
let mode: 'normal' | 'lost' | 'denied' | 'bare403';
const keys = {'owner-1':'audit-owner','buyer-agent':'audit-buyer','sourcing-agent':'audit-child','supplier-agent':'audit-supplier'};
const resource = {supplier_id:'supplier-co',sku_id:'PACK-500'};
async function listen(app: express.Express) { const s=app.listen(0,'127.0.0.1'); await new Promise<void>((r,j) => {s.once('listening',r);s.once('error',j);}); return s; }
const url = (s: Server) => `http://127.0.0.1:${(s.address() as {port:number}).port}`;
async function call(path: string, body?: unknown, token='audit-child') {
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {http:r.status,...await r.json()};
}
async function grant(actions=['supplier.purchase.execute'], budget=90000) {
  const r=await call('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope:{actions,...{supplier_ids:['supplier-co'],sku_ids:['PACK-500']},max_per_action_cents:budget,total_budget_cents:budget,expires_at:new Date(now.getTime()+60000).toISOString(),max_delegation_depth:0}},'audit-buyer');
  expect(r.http).toBe(200);return r.data.id as string;
}
const purchase = (grantId:string,key='purchase') => ({grant_id:grantId,action:'supplier.purchase.execute',...resource,quote_id:'q850',idempotency_key:key});
const row = () => db.prepare('SELECT * FROM purchases').get() as any;
const states = () => db.prepare('SELECT state,amount_cents FROM ledger_entries ORDER BY grant_id').all();
function reconcile(purchaseId:string, token='audit-owner', fixture=true) {
  return spawnSync(process.execPath,['--import','tsx',resolve('apps/authority/src/reconcile-fixture.ts'),'--fixture-supplier-db',join(directory,'seller.sqlite'),'--purchase-id',purchaseId],{cwd:process.cwd(),encoding:'utf8',env:{PATH:process.env.PATH,AUTHORITY_DB_PATH:join(directory,'authority.sqlite'),OWNER_API_KEY:token,...(fixture?{AGENTPASS_FIXTURE_RECONCILIATION:'1'}:{})}});
}
beforeEach(async() => {
  directory=mkdtempSync(join(tmpdir(),'agentpass-audit-fix-'));now=new Date();mode='normal';fulfillmentCalls=0;
  db=openDatabase(join(directory,'authority.sqlite'));seedDatabase(db,keys,now);
  sellerDb=new Database(join(directory,'seller.sqlite'));sellerDb.exec(readFileSync(resolve('db/supplier.sql'),'utf8'));
  sellerDb.prepare('INSERT INTO catalog VALUES(?,?,?,?,?,?)').run('PACK-500','Fixture product',1000,170,100,1);
  sellerDb.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?)').run('q850','supplier-co','PACK-500','sourcing-agent',500,85000,'USD',new Date(now.getTime()+120000).toISOString(),now.toISOString());
  const app=express();app.use(express.json());
  app.use((req,res,next) => {if(req.headers['x-service-key']!=='audit-service-secret'){res.sendStatus(401);return;}next();});
  app.post('/internal/policy/evaluate',(_req,res) => res.json({decision:'ALLOW'}));
  app.get('/internal/quotes/:id',(req,res) => {
    const q=sellerDb.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id) as any;
    res.json({quote_id:q.id,supplier_id:q.supplier_id,sku_id:q.sku_id,quantity:q.quantity,unit_price_cents:170,total_cents:q.total_cents,currency:q.currency,expires_at:q.expires_at,private_sentinel:'never-log-this'});
  });
  app.post('/internal/fulfill',(req,res) => {
    fulfillmentCalls++;
    if(mode==='denied'){res.status(403).json({status:'DENIED',code:'SELLER_POLICY_DENIED',reason:'private_sentinel never-log-this'});return;}
    if(mode==='bare403'){res.sendStatus(403);return;}
    sellerDb.prepare("INSERT OR IGNORE INTO orders VALUES(?,?,?,?,'COMPLETED',?)").run(`order-${req.body.request_id}`,req.body.request_id,req.body.buyer_principal_id,req.body.quote_id,now.toISOString());
    if(mode==='lost'){res.sendStatus(503);return;}
    res.json({order_id:(sellerDb.prepare('SELECT id FROM orders WHERE request_id=?').get(req.body.request_id) as any).id});
  });
  seller=await listen(app);authority=await listen(createAuthorityApp({db,supplier:new HttpSupplierService(url(seller),'audit-service-secret'),now:()=>new Date(now)}));base=url(authority);
});
afterEach(async() => {await Promise.all([authority,seller].filter(Boolean).map(s=>new Promise<void>((r,j)=>s.close(e=>e?j(e):r()))));db.close();sellerDb.close();rmSync(directory,{recursive:true,force:true});});

it.each(['quote expired','grant expired','grant revoked'])('operator reconciles a lost reply after %s without invoking fulfillment',async condition => {
  const g=await grant();mode='lost';expect((await call('/v1/actions/execute',purchase(g))).http).toBe(503);
  const id=row().id;
  if(condition==='grant revoked') await call(`/v1/grants/${g}/revoke`,{reason:'stop'},'audit-buyer');
  else if(condition==='grant expired') now=new Date(now.getTime()+61000);
  else {sellerDb.prepare("UPDATE quotes SET expires_at=? WHERE id='q850'").run(new Date(now.getTime()-1000).toISOString());}
  const retry=await call('/v1/actions/execute',purchase(g));expect(retry.http).toBe(403);
  const result=reconcile(id);expect(result.status,result.stderr).toBe(0);
  expect(row()).toMatchObject({status:'COMPLETED',supplier_order_id:`order-${id}`});
  expect(JSON.parse(row().receipt_json)).toMatchObject({amount_cents:85000,quantity:500,simulated:true,request_id:id});
  expect(states()).toEqual([{state:'COMMITTED',amount_cents:85000},{state:'COMMITTED',amount_cents:85000}]);
  expect(sellerDb.prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({n:1});
  const receipt=row().receipt_json;expect(reconcile(id).status).toBe(0);expect(row().receipt_json).toBe(receipt);
  expect(fulfillmentCalls).toBe(1);
  const events=db.prepare('SELECT * FROM audit_events WHERE request_id=?').all(id) as any[];
  const settled=events.filter(e=>e.action==='purchase.reconcile');expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({principal_id:'owner-1',grant_id:g,decision:'COMPLETED'});
  expect(new Set(events.map(e=>e.trace_id)).size).toBe(1);
});
it('refuses non-owner, missing fixture opt-in, absent and mismatched order evidence without releasing funds',async() => {
  const g=await grant();mode='lost';await call('/v1/actions/execute',purchase(g));const id=row().id;
  expect(reconcile(id,'audit-child').status).not.toBe(0);expect(reconcile(id,'audit-owner',false).status).not.toBe(0);
  db.prepare("UPDATE principal_keys SET revoked_at='2026-10-17T00:00:00Z' WHERE principal_id='owner-1'").run();expect(reconcile(id).status).not.toBe(0);
  db.prepare("UPDATE principal_keys SET revoked_at=NULL WHERE principal_id='owner-1'").run();
  sellerDb.prepare("UPDATE orders SET status='REJECTED'").run();expect(reconcile(id).status).not.toBe(0);
  sellerDb.prepare("UPDATE orders SET status='COMPLETED'").run();
  sellerDb.prepare('UPDATE orders SET buyer_principal_id=?').run('buyer-agent');expect(reconcile(id).status).not.toBe(0);
  sellerDb.prepare('UPDATE orders SET buyer_principal_id=?').run('sourcing-agent');
  sellerDb.prepare('UPDATE quotes SET total_cents=1').run();expect(reconcile(id).status).not.toBe(0);
  sellerDb.prepare('DELETE FROM orders').run();expect(reconcile(id).status).not.toBe(0);
  expect(row()).toMatchObject({status:'PENDING',receipt_json:null});expect(states().every((r:any)=>r.state==='RESERVED')).toBe(true);
  expect((await call('/v1/actions/execute',{...purchase(g),action:'purchase.reconcile'})).http).toBe(400);
});
it('preserves explicit supplier denial while retaining an uncertain reservation, and recovers on a valid retry',async() => {
  const g=await grant();mode='denied';const denied=await call('/v1/actions/execute',purchase(g));
  expect(denied).toMatchObject({http:403,status:'DENIED',code:'SELLER_POLICY_DENIED',next_action:'contact_owner'});
  expect(JSON.stringify(denied)).not.toContain('never-log-this');expect(row().status).toBe('PENDING');expect(states().every((r:any)=>r.state==='RESERVED')).toBe(true);
  expect(sellerDb.prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({n:0});
  mode='normal';expect((await call('/v1/actions/execute',purchase(g))).data.amount_cents).toBe(85000);
  expect(states().every((r:any)=>r.state==='COMMITTED')).toBe(true);expect(sellerDb.prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({n:1});
});
it('does not classify a bare HTTP 403 as proven supplier denial or release its reservation',async() => {
  const g=await grant();mode='bare403';expect((await call('/v1/actions/execute',purchase(g)))).toMatchObject({http:503,code:'SERVICE_UNAVAILABLE'});
  expect(states().every((r:any)=>r.state==='RESERVED')).toBe(true);
});
it('correlates reservation, completion and later grant denial without logging secrets or private response fields',async() => {
  const g=await grant();const done=await call('/v1/actions/execute',purchase(g));expect(done.http).toBe(200);
  await call(`/v1/grants/${g}/revoke`,{reason:'stop'},'audit-buyer');
  expect((await call('/v1/actions/execute',purchase(g))).code).toBe('GRANT_REVOKED');
  const audit=await call('/v1/audit',undefined,'audit-owner');
  const events=audit.data.filter((e:any)=>e.action==='supplier.purchase.execute'&&e.grant_id===g);
  expect(events.map((e:any)=>e.decision)).toEqual(['RESERVED','COMPLETED','DENY']);
  expect(events.every((e:any)=>e.request_id===done.data.request_id)).toBe(true);expect(new Set(events.map((e:any)=>e.trace_id)).size).toBe(1);
  for(const secret of [...Object.values(keys),'audit-service-secret','never-log-this']) expect(JSON.stringify(audit.data)).not.toContain(secret);
});
it('keeps authority negotiation events on one trace and does not expose the parent grant to another tenant',async() => {
  await grant(['supplier.quote.request'],0);
  const scope={actions:['supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:120000,total_budget_cents:120000,expires_at:new Date(now.getTime()+30000).toISOString(),max_delegation_depth:0};
  const requested=await call('/v1/authority/requests',{parent_grant_id:'grant-root-buyer',requested_scope:scope,reason:'Purchase'});
  const requestId=requested.data.request_id;
  expect((await call(`/v1/authority/requests/${requestId}/respond`,{decision:'COUNTEROFFER',offered_scope:scope})).code).toBe('INVALID_CALLER');
  expect((await call(`/v1/authority/requests/${requestId}/respond`,{decision:'COUNTEROFFER',offered_scope:{...scope,max_per_action_cents:90000,total_budget_cents:90000}},'audit-buyer')).http).toBe(200);
  expect((await call(`/v1/authority/requests/${requestId}/accept`,{idempotency_key:'accept'})).http).toBe(200);
  const events=(await call('/v1/audit',undefined,'audit-owner')).data.filter((e:any)=>e.request_id===requestId);
  expect(events).toHaveLength(5);expect(new Set(events.map((e:any)=>e.trace_id)).size).toBe(1);
  expect(events.some((e:any)=>e.action==='authority.respond'&&e.decision==='DENY'&&e.grant_id==='grant-root-buyer')).toBe(true);
  expect((await call(`/v1/authority/requests/${requestId}`,undefined,'audit-supplier')).http).toBe(403);
  const denied=db.prepare("SELECT grant_id,request_id FROM audit_events WHERE principal_id='supplier-agent' ORDER BY rowid DESC LIMIT 1").get();
  expect(denied).toEqual({grant_id:null,request_id:requestId});
});
