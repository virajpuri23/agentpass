import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../src/app.js';
import { HttpSupplierService } from '../src/supplier.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';

describe('HTTP supplier golden path',() => {
  let db: ReturnType<typeof openDatabase>; let authority: Server; let seller: Server; let base: string;
  let fulfillCount: number; let unavailable: boolean; let fulfillmentLost: boolean;
  const keys = {'owner-1':'test-owner','buyer-agent':'test-buyer','sourcing-agent':'test-child','supplier-agent':'test-supplier'};
  const quotes = new Map<string,any>(); const orders = new Map<string,string>();
  async function listen(app: express.Express) { const s = app.listen(0,'127.0.0.1'); await new Promise<void>(r => s.once('listening',r)); return s; }
  function url(s: Server) { return `http://127.0.0.1:${(s.address() as any).port}`; }
  async function call(path:string,body?:unknown,token='test-child') {
    const r = await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {http:r.status,...await r.json()};
  }
  const scope = (budget:number, actions:AuthorityScope['actions'] = ['supplier.purchase.execute']):AuthorityScope => ({actions,supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:budget,total_budget_cents:budget,expires_at:new Date(Date.now()+300000).toISOString(),max_delegation_depth:0});
  async function delegate(budget:number,actions?:AuthorityScope['actions']) { return (await call('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope:scope(budget,actions)},'test-buyer')).data; }
  function action(grant:string,key:string,quote='q850') { return {grant_id:grant,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quote,idempotency_key:key}; }
  beforeEach(async() => {
    fulfillCount=0;unavailable=false;fulfillmentLost=false;quotes.clear();orders.clear();
    db=openDatabase(':memory:');seedDatabase(db,keys);
    for (const [id,quantity] of [['q850',500],['q1200',800]] as const) quotes.set(id,{quote_id:id,supplier_id:'supplier-co',sku_id:'PACK-500',quantity,unit_price_cents:170,total_cents:quantity*170,currency:'USD',expires_at:new Date(Date.now()+600000).toISOString(),internal_unit_cost_cents:100});
    const app=express(); app.use(express.json());
    app.use((req,res,next) => { if(req.headers['x-service-key']!=='fixture-service') {res.sendStatus(401);return;} if(unavailable) {res.sendStatus(503);return;} next(); });
    app.post('/internal/policy/evaluate',(req,res) => res.json({status:'OK',data:{decision:req.body.action==='supplier.margin.read'?'DENY':'ALLOW'}}));
    app.post('/internal/quote',(_req,res) => res.json({status:'OK',data:quotes.get('q850')}));
    app.get('/internal/quotes/:id',(req,res) => res.json({status:'OK',data:quotes.get(req.params.id)}));
    app.post('/internal/fulfill',(req,res) => {
      if(!orders.has(req.body.request_id)) {orders.set(req.body.request_id,`order-${++fulfillCount}`);}
      if(fulfillmentLost) {res.sendStatus(503);return;}
      res.json({status:'OK',data:{order_id:orders.get(req.body.request_id),internal_unit_cost_cents:100}});
    });
    seller=await listen(app);
    authority=await listen(createAuthorityApp({db,supplier:new HttpSupplierService(url(seller),'fixture-service')})); base=url(authority);
  });
  afterEach(async() => { await Promise.all([authority,seller].map(s => new Promise<void>((r,j) => s.close(e => e?j(e):r()))));db.close(); });
  it('quotes, negotiates $1200 to $900, purchases $850 once, denies over-limit/private/revoked actions',async() => {
    const quoteGrant=await delegate(0,['supplier.quote.request']);
    const q=await call('/v1/actions/execute',{grant_id:quoteGrant.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'quote'});
    expect(q.data.total_cents).toBe(85000); expect(JSON.stringify(q)).not.toContain('internal_unit');
    const missing=await call('/v1/actions/execute',action(quoteGrant.id,'missing'));
    expect(missing.status).toBe('AUTHORITY_REQUIRED');expect(missing.required_scope.max_per_action_cents).toBe(85000);
    const requestedScope=scope(120000);
    const request=await call('/v1/authority/requests',{parent_grant_id:'grant-root-buyer',requested_scope:requestedScope,reason:'Purchase quote'});
    const requestId=request.data.request_id;
    const offer=await call(`/v1/authority/requests/${requestId}/respond`,{decision:'COUNTEROFFER',offered_scope:{...requestedScope,max_per_action_cents:90000,total_budget_cents:90000}},'test-buyer');expect(offer.data.status).toBe('COUNTEROFFERED');
    const grant=(await call(`/v1/authority/requests/${requestId}/accept`,{idempotency_key:'accept'})).data;
    const first=await call('/v1/actions/execute',action(grant.id,'purchase'));
    expect(first.data).toMatchObject({amount_cents:85000,simulated:true,outcome:'COMPLETED'});
    expect((await call('/v1/actions/execute',action(grant.id,'purchase'))).data).toEqual(first.data);expect(fulfillCount).toBe(1);
    expect((await call('/v1/actions/execute',action(grant.id,'large','q1200'))).code).toBe('BUDGET_EXCEEDED');
    expect((await call('/v1/actions/execute',{...action(grant.id,'margin'),action:'supplier.margin.read'})).code).toBe('SELLER_POLICY_DENIED');
    await call(`/v1/grants/${grant.id}/revoke`,{reason:'demo'},'test-buyer');
    expect((await call('/v1/actions/execute',action(grant.id,'revoked'))).code).toBe('GRANT_REVOKED');
    const ledger=db.prepare("SELECT grant_id,SUM(amount_cents) amount FROM ledger_entries WHERE state='COMMITTED' GROUP BY grant_id").all(); expect(ledger).toHaveLength(2);
    expect(ledger.every((r:any) => r.amount===85000)).toBe(true);
  });
  it('fails closed before reservation when supplier is unavailable',async() => {
    const grant=await delegate(90000);unavailable=true;
    expect((await call('/v1/actions/execute',action(grant.id,'unavailable'))).http).toBe(503);
    expect(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()).toEqual({n:0});
  });
  it('reconciles lost fulfillment responses with one order and one debit',async() => {
    const grant=await delegate(90000);fulfillmentLost=true;
    expect((await call('/v1/actions/execute',action(grant.id,'lost'))).http).toBe(503);
    expect(fulfillCount).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE state='RESERVED'").get()).toEqual({n:2});
    fulfillmentLost=false;
    expect((await call('/v1/actions/execute',action(grant.id,'lost'))).data.amount_cents).toBe(85000);
    expect(fulfillCount).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE state='COMMITTED'").get()).toEqual({n:2});
  });
});
