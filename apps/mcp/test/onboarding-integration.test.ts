import { createHash,randomBytes } from 'node:crypto';
import { createServer,type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe,expect,it } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { AuthorityEngine } from '../../authority/src/engine.js';
import { ConsentService } from '../../authority/src/consent.js';
import type { SupplierService } from '../../authority/src/supplier.js';

async function listen(server:Server){server.listen(0,'127.0.0.1');await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}

describe('public MCP self-service lifecycle (FIXTURE OAuth, consent and worker)',()=>{
  it('binds new tools to the caller and completes a child-key purchase/replay/revoke through the real MCP adapter',async()=>{
    const db=openDatabase(':memory:'),store=sqliteStore(db);await migrateStore(store,'sqlite');
    const secrets=new Map<string,string>(),organizations:string[]=[],orders=new Map<string,string>();
    const scope:AuthorityScope={actions:['supplier.quote.request','supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:2000,total_budget_cents:2000,expires_at:new Date(Date.now()+3500000).toISOString(),max_delegation_depth:2};
    const quote={quote_id:'mcp-fixture-quote',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,unit_price_cents:500,total_cents:500,currency:'USD' as const,expires_at:new Date(Date.now()+300000).toISOString()};
    const supplier:SupplierService={async policy(_p,action){return action!=='supplier.margin.read';},async quote(){return quote;},async getQuote(){return quote;},async fulfill(input){if(!orders.has(input.request_id))orders.set(input.request_id,`fixture-order-${orders.size+1}`);return {order_id:orders.get(input.request_id)!};}};
    const authority=createServer(createAuthorityApp({db,supplier,verifyHumanToken:async token=>{if(!['fixture.person.one','fixture.person.two'].includes(token))throw new Error('Invalid fixture access token');return {issuer:'https://fixture.example/',subject:token,client_id:'fixture-mcp-host'};},agentControl:{mcpUrl:'https://fixture.example/mcp',runners:[{id:'mcp-fixture-runner',keyHash:createHash('sha256').update('fixture-runner-token').digest('hex'),organizationIds:organizations}],credentials:{async ensure(ref){if(!secrets.has(ref))secrets.set(ref,randomBytes(32).toString('base64url'));return secrets.get(ref)!;},async read(ref){return secrets.get(ref)!;},async remove(ref){secrets.delete(ref);}}}}));
    const servers=[authority],clients:Client[]=[],previous={AUTHORITY_URL:process.env.AUTHORITY_URL,MCP_PUBLIC_URL:process.env.MCP_PUBLIC_URL};
    try{
      const apiUrl=await listen(authority);process.env.AUTHORITY_URL=apiUrl;delete process.env.MCP_PUBLIC_URL;
      const {default:adapter}=await import(`${pathToFileURL(process.cwd()+'/apps/mcp/agentpass-manufact/.mcp-use/build/index.js').href}?onboarding-mcp`);
      const {toNodeHandler}=await import('../agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');
      const mcp=createServer(toNodeHandler(adapter));servers.push(mcp);const mcpUrl=await listen(mcp)+'/mcp';
      const connect=async(token:string)=>{const client=new Client({name:'self-service-fixture',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl),{requestInit:{headers:{authorization:`Bearer ${token}`},redirect:'error'}}));clients.push(client);return client;};
      const call=async(client:Client,name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args})).structuredContent as any;
      const ok=async(client:Client,name:string,args:Record<string,unknown>={})=>{const result=await call(client,name,args);expect(result,JSON.stringify(result)).toMatchObject({status:'OK'});return result.data;};
      const parent=await connect('fixture.person.one'),other=await connect('fixture.person.two');
      expect((await parent.listTools()).tools.map(t=>t.name)).toEqual(expect.arrayContaining(['get_onboarding_context','provision_agent','list_agents','get_agent','revoke_agent','revoke_connection']));
      const context=await ok(parent,'get_onboarding_context');expect(context.connection.state).toBe('CONSENT_REQUIRED');
      const request={display_name:'MCP child',task:'Get a permitted quote and simulate purchase',requested_scope:{...scope,total_budget_cents:1000,max_per_action_cents:1000,max_delegation_depth:0},template_id:'sourcing-v1',idempotency_key:'mcp-provision'};
      expect(await call(parent,'provision_agent',request)).toMatchObject({status:'DENIED',code:'INSUFFICIENT_SCOPE'});
      // Trusted consent is a fixture here; the browser/CSRF journey is independently tested.
      const consent=new ConsentService(new AuthorityEngine(store,supplier),()=>scope),intent=await consent.request(context.account_id,context.connection.id,scope);await consent.approve(context.account_id,intent.id);organizations.push(context.organization.id);
      const activeContext=await ok(parent,'get_onboarding_context');
      const legacy=await call(parent,'provision_child',{parent_grant_id:activeContext.connection.grant_id,scope:{...scope,max_delegation_depth:1},credential_hash:createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex'),idempotency_key:'human-legacy-provision'});expect(legacy).toMatchObject({status:'DENIED',code:'INVALID_REQUEST',next_action:'contact_owner'});expect(legacy.reason).toContain('provision_agent');
      const agent=await ok(parent,'provision_agent',request);expect(agent.state).toBe('PROVISIONING');
      expect((await ok(parent,'provision_agent',request)).agent_id).toBe(agent.agent_id);
      expect(await call(parent,'provision_agent',{...request,task:'changed'})).toMatchObject({status:'DENIED',code:'ALREADY_EXECUTED'});
      expect(await call(other,'get_agent',{agent_id:agent.agent_id})).toMatchObject({status:'DENIED',code:'INSUFFICIENT_SCOPE'});
      const otherContext=await ok(other,'get_onboarding_context'),otherIntent=await consent.request(otherContext.account_id,otherContext.connection.id,scope);await consent.approve(otherContext.account_id,otherIntent.id);
      expect(await call(other,'get_agent',{agent_id:agent.agent_id})).toMatchObject({status:'DENIED',code:'INVALID_CALLER'});
      const http=async(path:string,body:unknown,token='fixture-runner-token')=>{const response=await fetch(apiUrl+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {response,result:await response.json() as any};};
      const claim=(await http('/internal/agent-jobs/claim',{idempotency_key:'mcp-claim'})).result.data.job;
      const delivery=await http(`/internal/agent-jobs/${claim.job_id}/credential`,{claim_id:claim.claim_id});expect(delivery.response.headers.get('cache-control')).toBe('no-store');const credential=delivery.result.data.credential;
      const child=await connect(credential);expect((await ok(child,'get_my_grants')).grants[0].id).toBe(agent.authority.grant_id);
      expect((await http(`/v1/agent-runs/${claim.job_id}/ready`,{claim_id:claim.claim_id},credential)).result.data.state).toBe('READY');
      const quoteResult=await ok(child,'execute_action',{grant_id:agent.authority.grant_id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,idempotency_key:'mcp-quote'});
      const purchase={grant_id:agent.authority.grant_id,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quoteResult.quote_id,idempotency_key:'mcp-purchase'};
      const receipt=await ok(child,'execute_action',purchase);expect(receipt).toMatchObject({amount_cents:500,simulated:true});expect(await ok(child,'execute_action',purchase)).toEqual(receipt);expect(orders.size).toBe(1);
      expect((await http(`/internal/agent-jobs/${claim.job_id}/result`,{claim_id:claim.claim_id,outcome:'COMPLETED',summary:'Fixture purchase complete'})).result.data.execution_state).toBe('COMPLETED');
      expect((await ok(parent,'get_agent',{agent_id:agent.agent_id})).execution_state).toBe('COMPLETED');expect((await ok(parent,'list_agents',{limit:1})).agents).toHaveLength(1);
      const publicOutput=JSON.stringify(await ok(parent,'get_agent',{agent_id:agent.agent_id}));expect(publicOutput).not.toContain(credential);expect(publicOutput).not.toContain(request.task);
      expect((await ok(parent,'revoke_agent',{agent_id:agent.agent_id,reason:'End fixture run',idempotency_key:'mcp-revoke'})).state).toBe('REVOKED');
      const denied=await fetch(apiUrl+'/v1/me',{headers:{authorization:`Bearer ${credential}`}});expect(denied.status).toBe(401);expect(secrets.size).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as any).n).toBe(1);expect((db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE state='COMMITTED' AND amount_cents=500").get() as any).n).toBe(2);
      expect(JSON.stringify(db.prepare('SELECT * FROM audit_events').all())).not.toContain(credential);
      expect((await ok(parent,'revoke_connection',{reason:'Disconnect fixture',idempotency_key:'disconnect'})).state).toBe('REVOKED');
      const disconnected=await fetch(apiUrl+'/v1/me',{headers:{authorization:'Bearer fixture.person.one'}});expect(disconnected.status).toBe(401);
    }finally{
      for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
      await Promise.all(clients.map(c=>c.close()));await Promise.all(servers.map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))));db.close();
    }
  });
});
