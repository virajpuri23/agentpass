import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { readChildCredential } from '../../cli/src/child-credential.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { postgresStore } from '../../../db/postgres.js';
import { seedPostgres } from '../../../db/seed-postgres.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { HttpSupplierService } from '../../authority/src/supplier.js';

const tools = ['get_workflow','list_runs','get_run','provision_child','describe_authority','get_my_grants','get_onboarding_context','provision_agent','list_agents','get_agent','revoke_agent','revoke_connection','request_authority','get_authority_request','respond_authority_request','accept_authority_offer','delegate_authority','execute_action','verify_authority','revoke_authority'];
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
  it.skipIf(backend==='postgres'&&!process.env.AGENTPASS_TEST_DATABASE_URL)('runs all ten tools, isolates callers, persists the $850 workflow and serializes shared budgets',async () => {
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
    let credentialDirectory:string|undefined;
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
        await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${token}`,'x-agentpass-run-id':`run-manufact-${backend}`},redirect:'error'}}));clients.push(client);return client;
      }
      const buyer=await connect(keys['buyer-agent']);const sourcing=await connect(keys['sourcing-agent']);const stranger=await connect(keys['supplier-agent']);
      const listed=await buyer.listTools();expect(listed.tools.map(t=>t.name).sort()).toEqual([...tools].sort());expect(listed.tools.every(t=>t.outputSchema)).toBe(true);
      async function call(client:Client,name:string,args:Record<string,unknown>={}) {return await client.callTool({name,arguments:args});}
      async function ok(client:Client,name:string,args:Record<string,unknown>={}) {const r=await call(client,name,args);expect(r.structuredContent,JSON.stringify(r.structuredContent)).toMatchObject({status:'OK'});return (r.structuredContent as any).data;}
      expect((await call(buyer,'get_onboarding_context')).structuredContent).toMatchObject({status:'DENIED',code:'INVALID_CALLER'});
      const description=await ok(buyer,'describe_authority');expect(description.actions).toContain('supplier.purchase.execute');
      expect((await ok(buyer,'get_my_grants')).grants[0].scope.total_budget_cents).toBe(100000);
      expect((await ok(sourcing,'get_my_grants')).grants).toEqual([]);
      expect((await ok(buyer,'get_workflow',{root_grant_id:'grant-root-buyer'})).root_grant_id).toBe('grant-root-buyer');
      expect((await call(stranger,'get_workflow',{root_grant_id:'grant-root-buyer'})).structuredContent).toMatchObject({status:'DENIED',code:'INVALID_REQUEST'});
      const runCli=promisify(execFile);
      for(const [token,expected,principal] of [[keys['buyer-agent'],'ONBOARDED','buyer-agent'],[keys['sourcing-agent'],'AUTHENTICATED_NO_GRANTS','sourcing-agent']] as const){
        const {stdout,stderr}=await runCli(process.execPath,['--import','tsx','apps/cli/src/onboard.ts','--url',mcpUrl],{env:{...process.env,AGENT_API_KEY:token}});
        const onboarding=JSON.parse(stdout);expect(onboarding).toMatchObject({status:'OK',code:expected,data:{principal_id:principal,organization_id:'buyer-co',requires_browser:false,side_effects:false}});
        expect(onboarding.data.tools.sort()).toEqual([...tools].sort());expect(stdout+stderr).not.toContain(token);
      }
      try {await runCli(process.execPath,['--import','tsx','apps/cli/src/onboard.ts','--url',mcpUrl],{env:{...process.env,AGENT_API_KEY:'invalid-cli-fixture'}});throw new Error('Invalid credential unexpectedly succeeded');}
      catch(error){expect(error).toMatchObject({code:1});expect(JSON.parse((error as any).stdout)).toMatchObject({status:'ERROR',code:'INVALID_CREDENTIAL'});expect((error as any).stdout+(error as any).stderr).not.toContain('invalid-cli-fixture');}
      expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM authority_requests').get() as any).n)).toBe(0);
      expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as any).n)).toBe(0);
      expect((await call(buyer,'get_my_grants'))._meta).toMatchObject({inspector:{budgets:[{grant_id:'grant-root-buyer',remaining_budget_cents:100000}]}});
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
      const recorded=await ok(sourcing,'get_run',{run_id:`run-manufact-${backend}`});expect(recorded.receipts).toEqual([receipt]);expect(recorded.activity.every((e:any)=>e.trace_id===`run-manufact-${backend}`&&e.principal_id==='sourcing-agent')).toBe(true);expect((await ok(sourcing,'list_runs')).runs[0].run_id).toBe(`run-manufact-${backend}`);
      const cliRun=await runCli(process.execPath,['--import','tsx','apps/cli/src/runs.ts','--url',mcpUrl,'--run',`run-manufact-${backend}`],{env:{...process.env,AGENT_API_KEY:keys['sourcing-agent']}});expect(JSON.parse(cliRun.stdout).data.receipts).toEqual([receipt]);expect(cliRun.stdout+cliRun.stderr).not.toContain(keys['sourcing-agent']);
      expect((await ok(buyer,'get_workflow',{root_grant_id:'grant-root-buyer'})).receipts).toEqual([receipt]);
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
      for (const [principal,token] of [['sourcing-agent',keys['sourcing-agent']],['supplier-agent',keys['supplier-agent']]] as const) {
        const snapshot=await fetch(`${apiUrl}/v1/console`,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.json());
        expect(snapshot.status).toBe('OK');expect(snapshot.data.principal.id).toBe(principal);
        if(principal==='sourcing-agent') {
          expect(snapshot.data.requests[0].status).toBe('ACCEPTED');expect(snapshot.data.receipts).toContainEqual(receipt);
          expect(snapshot.data.budgets).toContainEqual({grant_id:grant.id,remaining_budget_cents:null,authority_code:'GRANT_REVOKED'});
        } else {expect(snapshot.data.grants).toEqual([]);expect(snapshot.data.requests).toEqual([]);expect(snapshot.data.receipts).toEqual([]);}
        expect(JSON.stringify(snapshot)).not.toMatch(/manufact-fixture-|fixture-backend-secret|internal_unit_cost|key_hash/);
      }
      expect(JSON.stringify([receipt,inspected,missing])).not.toMatch(/manufact-fixture-|fixture-backend-secret|internal_unit_cost|margin_cents/);
      const audit=await fetch(`${apiUrl}/v1/audit`,{headers:{authorization:`Bearer ${keys['owner-1']}`}}).then(r=>r.json());expect(audit.data.some((e:any)=>e.decision==='COMPLETED'&&e.principal_id==='sourcing-agent')).toBe(true);
      // A separate local fixture allocation keeps the original golden-path ledger intact.
      await db.prepare('INSERT INTO grants(id,organization_id,parent_grant_id,issuer_principal_id,subject_principal_id,scope_json,created_at) VALUES(?,?,NULL,?,?,?,?)').run('grant-provision-parent','buyer-co','owner-1','buyer-agent',JSON.stringify({...scope(100000,['supplier.quote.request','supplier.purchase.execute']),max_delegation_depth:2}),new Date().toISOString());
      credentialDirectory=mkdtempSync(join(tmpdir(),'agentpass-provision-cli-'));
      const scopePath=join(credentialDirectory,'scope.json'),credentialPath=join(credentialDirectory,'child.json');
      writeFileSync(scopePath,JSON.stringify({...scope(90000,['supplier.quote.request','supplier.purchase.execute']),max_delegation_depth:1}));
      const provisionArgs=['--import','tsx','apps/cli/src/provision.ts','--url',mcpUrl,'--parent-grant','grant-provision-parent','--scope-file',scopePath,'--credential-file',credentialPath];
      const parentEnvironment={...process.env,AGENT_API_KEY:keys['buyer-agent']};
      const provisioned=await runCli(process.execPath,provisionArgs,{env:parentEnvironment});const issued=JSON.parse(provisioned.stdout);expect(issued).toMatchObject({status:'OK',code:'CHILD_PROVISIONED',data:{principal:{kind:'AGENT',role:'SERVICE',organization_id:'buyer-co'}}});
      const replayed=JSON.parse((await runCli(process.execPath,provisionArgs,{env:parentEnvironment})).stdout);expect(replayed.data).toEqual(issued.data);
      const credential=readChildCredential(credentialPath);expect(provisioned.stdout+provisioned.stderr).not.toContain(credential.credential);
      // Explicit file selection must use the child, even if the inherited environment has a parent key.
      const childOnboard=JSON.parse((await runCli(process.execPath,['--import','tsx','apps/cli/src/onboard.ts','--credential-file',credentialPath],{env:parentEnvironment})).stdout);expect(childOnboard.data.principal_id).toBe(issued.data.principal.id);expect(childOnboard.data.inspector.budgets[0].remaining_budget_cents).toBe(90000);
      const runtimeChild=await connect(credential.credential);
      expect((await ok(runtimeChild,'execute_action',{grant_id:issued.data.grant.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'new-child-quote'})).total_cents).toBe(85000);
      expect(await ok(runtimeChild,'execute_action',purchase(issued.data.grant.id,'new-child-purchase'))).toMatchObject({simulated:true,amount_cents:85000});
      const verifier=createHash('sha256').update(randomBytes(32)).digest('hex');
      expect((await call(runtimeChild,'provision_child',{parent_grant_id:issued.data.grant.id,scope:scope(6000),credential_hash:verifier,idempotency_key:'too-large'})).structuredContent).toMatchObject({code:'BUDGET_EXCEEDED'});
      expect((await call(stranger,'provision_child',{parent_grant_id:'grant-provision-parent',scope:scope(0,['supplier.quote.request']),credential_hash:verifier,idempotency_key:'foreign'})).structuredContent).toMatchObject({code:'INVALID_CALLER'});
      const grandchildSecret=randomBytes(32).toString('base64url');
      const grandchild=await ok(runtimeChild,'provision_child',{parent_grant_id:issued.data.grant.id,scope:scope(0,['supplier.quote.request']),credential_hash:createHash('sha256').update(grandchildSecret).digest('hex'),idempotency_key:'grandchild'});expect(grandchild.principal.role).toBe('SERVICE');
      const grandchildClient=await connect(grandchildSecret);expect((await ok(grandchildClient,'get_my_grants')).grants[0].id).toBe(grandchild.grant.id);
      await ok(buyer,'revoke_authority',{grant_id:issued.data.grant.id,reason:'Stop provisioned family'});
      for(const token of [credential.credential,grandchildSecret])expect((await fetch(`${apiUrl}/v1/me`,{headers:{authorization:`Bearer ${token}`}})).status).toBe(401);
      try{await runCli(process.execPath,['--import','tsx','apps/cli/src/onboard.ts','--credential-file',credentialPath],{env:parentEnvironment});throw new Error('Revoked child authenticated');}catch(error){expect(JSON.parse((error as any).stdout)).toMatchObject({code:'INVALID_CREDENTIAL'});}
      expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM child_provisionings').get() as any).n)).toBe(2);
      if(pg)expect((await pg.store.prepare("SELECT relrowsecurity FROM pg_class WHERE oid='agentpass.child_provisionings'::regclass").get()).relrowsecurity).toBe(true);
      if(pg) {await pg.close();const reopened=postgresStore(process.env.AGENTPASS_TEST_DATABASE_URL!);try{expect((await reopened.store.prepare("SELECT COUNT(*)::int AS n FROM purchases WHERE status='COMPLETED'").get()).n).toBe(3);}finally{await reopened.close();}}
    } finally {
      if(previousUrl===undefined)delete process.env.AUTHORITY_URL;else process.env.AUTHORITY_URL=previousUrl;
      await Promise.all(clients.map(c=>c.close()));await Promise.all(servers.map(s=>new Promise<void>(r=>s.close(()=>r()))));
      if(credentialDirectory)rmSync(credentialDirectory,{recursive:true,force:true});
      sqlite?.close();await otherPg?.close();if(pg) await pg.close().catch(()=>undefined);
    }
  },30000);
});

it.skipIf(!process.env.AGENTPASS_TEST_DATABASE_URL)('runs the embedded production architecture with Developer B supplier and durable PostgreSQL', async () => {
  const connection = process.env.AGENTPASS_TEST_DATABASE_URL!;
  const target = new URL(connection);
  if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A disposable local test database is required.');
  const pg = postgresStore(connection);
  await pg.migrate();
  await pg.store.prepare('TRUNCATE organizations,principals,principal_keys,grants,authority_requests,purchases,ledger_entries,audit_events CASCADE').run();
  await seedPostgres(pg, keys);
  // Plain local PostgreSQL has no Supabase API roles; retain the PUBLIC revocations.
  await pg.store.prepare(readFileSync('supabase/migrations/20261017213000_supplier_schema.sql','utf8').replaceAll('PUBLIC, anon, authenticated','PUBLIC')).run();
  await pg.store.prepare('TRUNCATE supplier.orders,supplier.quotes; UPDATE supplier.catalog SET stock_quantity=1000').run();
  const env: NodeJS.ProcessEnv = {...process.env, DATABASE_URL:connection, SUPPLIER_DATABASE_URL:connection, SUPPLIER_SERVICE_KEY:'embedded-test-service-key'};
  delete env.AUTHORITY_URL; delete env.SUPPLIER_URL;
  const script = `import {createServer} from 'node:http';
    import server from './apps/mcp/agentpass-manufact/.mcp-use/build/index.js';
    import {toNodeHandler} from './apps/mcp/agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js';
    const http=createServer(toNodeHandler(server));
    http.listen(0,'127.0.0.1',()=>console.log('MCP_URL=http://127.0.0.1:'+http.address().port+'/mcp'));
    process.once('SIGTERM',()=>http.close());`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','pipe','pipe']});
  const clients:Client[]=[];
  try {
    const url=await new Promise<string>((resolve,reject) => {
      let output='';
      child.stdout.on('data',chunk => {output+=String(chunk);const match=output.match(/MCP_URL=(\S+)/);if(match)resolve(match[1]);});
      child.once('exit',code => reject(new Error(`Embedded MCP exited before readiness: ${code}`)));
      child.once('error',reject);
    });
    expect((await fetch(new URL('/health',url))).status).toBe(200);
    expect((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'})).status).toBe(401);
    async function connect(key:string) {const c=new Client({name:'embedded-real-supplier-test',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:`Bearer ${key}`}}}));clients.push(c);return c;}
    const buyer=await connect(keys['buyer-agent']), sourcing=await connect(keys['sourcing-agent']);
    async function call(c:Client,name:string,args:Record<string,unknown>={}) {return (await c.callTool({name,arguments:args})).structuredContent as any;}
    async function ok(c:Client,name:string,args:Record<string,unknown>={}) {const r=await call(c,name,args);expect(r.status,JSON.stringify(r)).toBe('OK');return r.data;}
    expect((await buyer.listTools()).tools.map(t=>t.name).sort()).toEqual([...tools].sort());
    const quoteGrant=await ok(buyer,'delegate_authority',{parent_grant_id:'grant-root-buyer',recipient_principal_id:'sourcing-agent',scope:scope(0,['supplier.quote.request'])});
    const quote=await ok(sourcing,'execute_action',{grant_id:quoteGrant.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'real-quote'});
    expect(quote.total_cents).toBe(85000);
    expect(await call(sourcing,'execute_action',purchase(quoteGrant.id,'blocked',quote.quote_id))).toMatchObject({status:'AUTHORITY_REQUIRED',next_action:'request_authority',required_scope:{total_budget_cents:85000}});
    const request=await ok(sourcing,'request_authority',{parent_grant_id:'grant-root-buyer',requested_scope:scope(120000),reason:'Real supplier purchase'});
    await ok(buyer,'respond_authority_request',{request_id:request.request_id,decision:'COUNTEROFFER',offered_scope:scope(90000)});
    const grant=await ok(sourcing,'accept_authority_offer',{request_id:request.request_id,idempotency_key:'real-accept'});
    const receipt=await ok(sourcing,'execute_action',purchase(grant.id,'real-purchase',quote.quote_id));
    expect(receipt.amount_cents).toBe(85000);
    expect(await ok(sourcing,'execute_action',purchase(grant.id,'real-purchase',quote.quote_id))).toEqual(receipt);
    expect((await pg.store.prepare('SELECT COUNT(*)::int AS n FROM supplier.orders').get()).n).toBe(1);
    expect((await pg.store.prepare("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE state='COMMITTED'").get()).n).toBe(2);
    await ok(buyer,'revoke_authority',{grant_id:grant.id,reason:'Test complete'});
    expect(await call(sourcing,'execute_action',purchase(grant.id,'after-revoke',quote.quote_id))).toMatchObject({code:'GRANT_REVOKED'});
    expect(JSON.stringify([quote,receipt])).not.toMatch(/internal_unit_cost|margin_cents|embedded-test-service-key/);
  } finally {
    await Promise.all(clients.map(c=>c.close()));
    child.kill('SIGTERM');
    await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});
    await pg.close();
  }
},30000);
