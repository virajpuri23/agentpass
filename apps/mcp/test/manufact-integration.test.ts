import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { postgresStore } from '../../../db/postgres.js';
import { seedPostgres } from '../../../db/seed-postgres.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';

const tools = ['describe_authority','get_my_grants','request_authority','get_authority_request','respond_authority_request','accept_authority_offer','delegate_authority','execute_action','revoke_authority'];
const keys = {'owner-1':'manufact-fixture-owner','buyer-agent':'manufact-fixture-buyer','sourcing-agent':'manufact-fixture-sourcing','supplier-agent':'manufact-fixture-supplier'};
async function listen(server: Server) {
  server.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject) => {server.once('listening',resolve);server.once('error',reject);});
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
const expiry = new Date(Date.now()+300000).toISOString();
const scope = (budget:number,actions=['supplier.purchase.execute']) => ({actions,supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:budget,total_budget_cents:budget,expires_at:expiry,max_delegation_depth:0});
const purchase = (grant_id:string,idempotency_key:string,quote_id='q850') => ({grant_id,idempotency_key,quote_id,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500'});

for (const backend of ['sqlite','postgres'] as const) describe(`Manufact HTTP MCP → authority → supplier fixture (${backend})`,() => {
  it.skipIf(backend==='postgres'&&!process.env.AGENTPASS_TEST_DATABASE_URL)('runs all nine tools, isolates callers, persists the $850 workflow and serializes shared budgets',async () => {
    if (backend==='postgres') {
      const target = new URL(process.env.AGENTPASS_TEST_DATABASE_URL!);
      if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('PostgreSQL integration tests require a disposable local database ending in _test.');
    }
    const sqlite = backend==='sqlite' ? openDatabase(':memory:') : undefined;
    const pg = backend==='postgres' ? postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!) : undefined;
    if (pg) {
      await pg.migrate();
      await pg.store.prepare('TRUNCATE organizations,principals,principal_keys,grants,authority_requests,purchases,ledger_entries,audit_events CASCADE').run();
      await seedPostgres(pg,keys);
    } else seedDatabase(sqlite!,keys);
    const db = pg?.store ?? sqlite!;
    const servers:Server[]=[]; const clients:Client[]=[];
    const orders = new Map<string,string>();
    const quote = (id:string) => ({quote_id:id,supplier_id:'supplier-co',sku_id:'PACK-500',quantity:id==='q850'?500:10,unit_price_cents:id==='q850'?170:1000,total_cents:id==='q850'?85000:10000,currency:'USD',expires_at:new Date(Date.now()+600000).toISOString(),internal_unit_cost_cents:77});
    const seller=express();seller.use(express.json());
    seller.use((req,res,next) => {if(req.headers['x-service-key']!=='fixture-backend-secret') {res.sendStatus(401);return;}next();});
    seller.post('/internal/policy/evaluate',(req,res) => res.json({decision:req.body.action==='supplier.margin.read'?'DENY':'ALLOW'}));
    seller.post('/internal/quote',(_req,res) => res.json(quote('q850')));
    seller.get('/internal/quotes/:id',(req,res) => res.json(quote(String(req.params.id))));
    seller.post('/internal/fulfill',(req,res) => {if(!orders.has(req.body.request_id))orders.set(req.body.request_id,`fixture-order-${orders.size+1}`);res.json({order_id:orders.get(req.body.request_id),internal_unit_cost_cents:77});});
    const sellerServer=createServer(seller);servers.push(sellerServer);const sellerUrl=await listen(sellerServer);
    const supplier = new HttpSupplierService(sellerUrl,'fixture-backend-secret');
    const api=createServer(createAuthorityApp({db,supplier}));servers.push(api);const apiUrl=await listen(api);
    const previousUrl=process.env.AUTHORITY_URL;process.env.AUTHORITY_URL=apiUrl;
    let otherPg:ReturnType<typeof postgresStore>|undefined;
    try {
      const moduleUrl=pathToFileURL(`${process.cwd()}/apps/mcp/agentpass-manufact/.mcp-use/build/index.js`).href;
      const {default:adapter}=await import(`${moduleUrl}?backend=${backend}`);
      const {toNodeHandler}=await import('../agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');
      const http=createServer(toNodeHandler(adapter,{onerror:error=>console.error(error.message)}));servers.push(http);const mcpUrl=`${await listen(http)}/mcp`;
      const health=await fetch(new URL('/health',mcpUrl));expect(health.status).toBe(200);expect(await health.json()).toEqual({status:'OK'});
      for(const token of [undefined,'unknown-agent']) {
        const denied=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
        expect(denied.status,await denied.text()).toBe(401);
      }
      async function connect(token:string,url=mcpUrl) {
        const client=new Client({name:'agentpass-independent-http-test',version:'1.0.0'});
        await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${token}`},redirect:'error'}}));clients.push(client);return client;
      }
      const buyer=await connect(keys['buyer-agent']);const sourcing=await connect(keys['sourcing-agent']);const stranger=await connect(keys['supplier-agent']);
      const listed=await buyer.listTools();expect(listed.tools.map(t=>t.name).sort()).toEqual([...tools].sort());expect(listed.tools.every(t=>t.outputSchema)).toBe(true);
      async function call(client:Client,name:string,args:Record<string,unknown>={}) {return await client.callTool({name,arguments:args});}
      async function ok(client:Client,name:string,args:Record<string,unknown>={}) {const r=await call(client,name,args);expect(r.structuredContent,JSON.stringify(r.structuredContent)).toMatchObject({status:'OK'});return (r.structuredContent as any).data;}
      const description=await ok(buyer,'describe_authority');expect(description.actions).toContain('supplier.purchase.execute');
      expect((await ok(buyer,'get_my_grants')).grants[0].scope.total_budget_cents).toBe(100000);
      expect((await ok(sourcing,'get_my_grants')).grants).toEqual([]);
      const child=await ok(buyer,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(0,['supplier.quote.request'])});
      expect((await ok(sourcing,'get_my_grants')).grants.map((g:any)=>g.id)).toEqual([child.id]);
      const issuedQuote=await ok(sourcing,'execute_action',{grant_id:child.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'quote'});expect(issuedQuote.total_cents).toBe(85000);expect(JSON.stringify(issuedQuote)).not.toContain('internal_unit');
      const missing=await call(sourcing,'execute_action',purchase(child.id,'missing'));expect(missing.structuredContent).toMatchObject({status:'AUTHORITY_REQUIRED',code:'INSUFFICIENT_SCOPE',next_action:'request_authority',required_scope:{max_per_action_cents:85000,total_budget_cents:85000}});
      const request=await ok(sourcing,'request_authority',{parent_grant_id:'grant-root-buyer',requested_scope:scope(120000),reason:'Purchase trusted quote'});
      expect((await ok(buyer,'get_authority_request',{request_id:request.request_id})).status).toBe('PENDING');
      expect((await call(stranger,'get_authority_request',{request_id:request.request_id})).structuredContent).toMatchObject({status:'DENIED',code:'INVALID_CALLER'});
      expect((await call(sourcing,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(90000)})).structuredContent).toMatchObject({status:'DENIED'});
      expect((await call(buyer,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(120000)})).structuredContent).toMatchObject({code:'OUTSIDE_PARENT_SCOPE'});
      expect((await call(sourcing,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(0),agent_id:'buyer-agent'})).isError).toBe(true);
      expect((await ok(buyer,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(90000)})).status).toBe('COUNTEROFFERED');
      const grant=await ok(sourcing,'accept_authority_offer',{request_id:request.request_id,idempotency_key:'accept'});
      const receipt=await ok(sourcing,'execute_action',purchase(grant.id,'purchase'));expect(receipt).toMatchObject({amount_cents:85000,simulated:true,outcome:'COMPLETED'});
      expect(await ok(sourcing,'execute_action',purchase(grant.id,'purchase'))).toEqual(receipt);expect(orders.size).toBe(1);
      const inspected=await call(sourcing,'get_my_grants');expect((inspected._meta as any).principal_id).toBe('sourcing-agent');expect((inspected._meta as any).inspector.budgets).toContainEqual({grant_id:grant.id,remaining_budget_cents:5000,authority_code:'ACTIVE'});
      expect((await call(sourcing,'execute_action',{...purchase(grant.id,'margin'),action:'supplier.margin.read'})).structuredContent).toMatchObject({code:'SELLER_POLICY_DENIED'});
      const first=await ok(buyer,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(15000)});
      const second=await ok(buyer,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(15000)});
      let secondClient=sourcing;
      if(pg) {
        otherPg=postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!);
        const secondApi=createServer(createAuthorityApp({db:otherPg.store,supplier}));servers.push(secondApi);const secondUrl=await listen(secondApi);
        process.env.AUTHORITY_URL=secondUrl;
        const {default:replica}=await import(`${moduleUrl}?replica=postgres`);
        const secondMcp=createServer(toNodeHandler(replica));servers.push(secondMcp);secondClient=await connect(keys['sourcing-agent'],`${await listen(secondMcp)}/mcp`);
      }
      const race=await Promise.all([call(sourcing,'execute_action',purchase(first.id,'race-one','q100')),call(secondClient,'execute_action',purchase(second.id,'race-two','q100'))]);
      expect(race.map(r=>(r.structuredContent as any).status).sort()).toEqual(['DENIED','OK']);expect(race.some(r=>(r.structuredContent as any).code==='BUDGET_EXCEEDED')).toBe(true);expect(orders.size).toBe(2);
      await ok(buyer,'revoke_authority',{grant_id:grant.id,reason:'Demo complete'});
      expect((await call(sourcing,'execute_action',purchase(grant.id,'revoked'))).structuredContent).toMatchObject({code:'GRANT_REVOKED'});
      if(pg) await pg.store.prepare('UPDATE grants SET scope_json=? WHERE id=?').run(JSON.stringify({...scope(0,['supplier.quote.request']),expires_at:new Date(0).toISOString()}),child.id);
      else sqlite!.prepare('UPDATE grants SET scope_json=? WHERE id=?').run(JSON.stringify({...scope(0,['supplier.quote.request']),expires_at:new Date(0).toISOString()}),child.id);
      expect((await call(sourcing,'execute_action',{grant_id:child.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'expired'})).structuredContent).toMatchObject({code:'GRANT_EXPIRED'});
      expect(JSON.stringify([receipt,inspected,missing])).not.toMatch(/manufact-fixture-|fixture-backend-secret|internal_unit_cost|margin_cents/);
      const audit=await fetch(`${apiUrl}/v1/audit`,{headers:{authorization:`Bearer ${keys['owner-1']}`}}).then(r=>r.json());expect(audit.data.some((e:any)=>e.decision==='COMPLETED'&&e.principal_id==='sourcing-agent')).toBe(true);
      if(pg) {await pg.close();const reopened=postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!);try{expect((await reopened.store.prepare("SELECT COUNT(*)::int AS n FROM purchases WHERE status='COMPLETED'").get()).n).toBe(2);}finally{await reopened.close();}}
    } finally {
      if(previousUrl===undefined)delete process.env.AUTHORITY_URL;else process.env.AUTHORITY_URL=previousUrl;
      await Promise.all(clients.map(c=>c.close()));await Promise.all(servers.map(s=>new Promise<void>(r=>s.close(()=>r()))));
      sqlite?.close();await otherPg?.close();if(pg) await pg.close().catch(()=>undefined);
    }
  },30000);
});
