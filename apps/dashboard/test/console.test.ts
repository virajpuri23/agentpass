import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../../authority/src/app.js';
import { createConsoleHandler } from '../src/handler.js';
import type { SupplierService } from '../../authority/src/supplier.js';

const keys={'owner-1':'console-test-owner','buyer-agent':'console-test-buyer','sourcing-agent':'console-test-child','supplier-agent':'console-test-supplier'};
const expiry=new Date(Date.now()+3600000).toISOString();
const scope=(amount=90000)=>({actions:['supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:amount,total_budget_cents:amount,expires_at:expiry,max_delegation_depth:0});
const quote={quote_id:'console-quote',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,unit_price_cents:170,total_cents:85000,currency:'USD' as const,expires_at:expiry};
const supplier:SupplierService={policy:async()=>true,quote:async()=>quote,getQuote:async()=>quote,fulfill:async()=>({order_id:'simulated-console-order'})};

describe('authenticated console → HTTP MCP → canonical authority',()=>{
  let db:ReturnType<typeof openDatabase>,api:Server,mcp:Server,base:string,origin:string,clock:number;
  let handle:ReturnType<typeof createConsoleHandler>;
  let previous:Record<string,string|undefined>;
  async function listen(s:Server){s.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));return `http://127.0.0.1:${(s.address() as any).port}`;}
  async function direct(path:string,body?:unknown,token=keys['buyer-agent']){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {http:r.status,...await r.json()};}
  async function call(path:string,body?:unknown,cookie='',extra:Record<string,string>={}){return handle(new Request(origin+'/console-api/'+path,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
  async function login(token=keys['buyer-agent']){const r=await call('session',{credential:token});expect(r.status,await r.clone().text()).toBe(200);return r.headers.get('set-cookie')!.split(';')[0];}
  async function childGrant(){return (await direct('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope:{...scope(0),actions:['supplier.quote.request']}})).data;}
  async function childRequest(){await childGrant();return (await direct('/v1/authority/requests',{parent_grant_id:'grant-root-buyer',requested_scope:scope(120000),reason:'Console integration request'},keys['sourcing-agent'])).data.request_id;}
  beforeAll(async()=>{
    db=openDatabase(':memory:');seedDatabase(db,keys);api=createServer(createAuthorityApp({db,supplier}));base=await listen(api);mcp=createServer();origin=await listen(mcp);
    previous={AUTHORITY_URL:process.env.AUTHORITY_URL,CONSOLE_ORIGIN:process.env.CONSOLE_ORIGIN,MCP_PUBLIC_URL:process.env.MCP_PUBLIC_URL};
    process.env.AUTHORITY_URL=base;process.env.CONSOLE_ORIGIN=origin;process.env.MCP_PUBLIC_URL=origin+'/mcp';
    const {default:adapter}=await import(pathToFileURL(process.cwd()+'/apps/mcp/agentpass-manufact/.mcp-use/build/index.js').href+'?console-tests');
    const {toNodeHandler}=await import('../../mcp/agentpass-manufact/node_modules/mcp-use/dist/node-bridge.js');mcp.on('request',toNodeHandler(adapter,{onerror:()=>{}}));
  });
  beforeEach(()=>{
    db.exec('DELETE FROM ledger_entries; DELETE FROM purchases; DELETE FROM authority_requests; DELETE FROM audit_events; DELETE FROM grants; DELETE FROM principal_keys; DELETE FROM principals; DELETE FROM organizations;');seedDatabase(db,keys);clock=Date.now();
    handle=createConsoleHandler({authorityUrl:base,mcpUrl:origin+'/mcp',origin,now:()=>clock});
  });
  afterAll(async()=>{await Promise.all([api,mcp].map(s=>new Promise<void>(r=>s.close(()=>r()))));db.close();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  it('serves same-origin connection assets from the built MCP server without exposing private routes',async()=>{
    expect((await fetch(origin+'/connect')).status).toBe(200);expect(await (await fetch(origin+'/console.js')).text()).toContain('Verify identity');expect((await fetch(origin+'/v1/console')).status).toBe(404);
  });
  it('verifies actual MCP principal/org/grants and keeps the credential out of responses and cookies',async()=>{
    const response=await call('session',{credential:keys['buyer-agent']});const text=await response.text();expect(response.status).toBe(200);expect(JSON.parse(text).data).toMatchObject({principal_id:'buyer-agent',organization_id:'buyer-co',role:'BUYER'});expect(JSON.parse(text).data.grants).toHaveLength(1);
    expect(text).not.toContain(keys['buyer-agent']);const cookie=response.headers.get('set-cookie')!;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Strict');expect(cookie).not.toContain(keys['buyer-agent']);expect(response.headers.get('cache-control')).toBe('no-store');
    const snapshot=await (await call('snapshot',undefined,cookie.split(';')[0])).json();expect(snapshot.data.principal.id).toBe('buyer-agent');
  });
  it('distinguishes missing, invalid, unavailable endpoint and authenticated-with-no-grants',async()=>{
    expect((await (await call('session',{})).json()).code).toBe('MISSING_CREDENTIAL');expect((await (await call('session',{credential:'bad-key'})).json()).code).toBe('INVALID_CREDENTIAL');
    const noGrants=await (await call('session',{credential:keys['supplier-agent']})).json();expect(noGrants.status).toBe('OK');expect(noGrants.data.grants).toEqual([]);
    handle=createConsoleHandler({authorityUrl:base,mcpUrl:'http://127.0.0.1:1/mcp',origin});expect((await call('session',{credential:keys['buyer-agent']})).status).toBe(503);
  });
  it('fails closed for missing session, cross-origin POST, arbitrary proxy paths, malformed identity and expiry/logout',async()=>{
    expect((await call('snapshot')).status).toBe(401);expect((await call('session',{credential:keys['buyer-agent']},'',{origin:'https://evil.invalid'})).status).toBe(403);
    expect((await call('session',{credential:keys['buyer-agent'],principal_id:'owner-1'})).status).toBe(401);
    const cookie=await login();expect((await call('v1/actions/execute',{},cookie)).status).toBe(404);clock+=3600001;expect((await call('snapshot',undefined,cookie)).status).toBe(401);
    const next=await login();await call('logout',{},next);expect((await call('snapshot',undefined,next)).status).toBe(401);
  });
  it('requires secure configured service URLs, bounds bodies and rechecks revoked credentials',async()=>{
    expect(()=>createConsoleHandler({authorityUrl:'http://remote.invalid',mcpUrl:origin+'/mcp',origin})).toThrow();
    expect(()=>createConsoleHandler({authorityUrl:base,mcpUrl:'https://remote.invalid/mcp?credential=no',origin})).toThrow();
    expect((await call('session',{credential:'x'.repeat(40000)})).status).toBe(413);
    const malformed=await handle(new Request(origin+'/console-api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{'}));expect(malformed.status).toBe(400);
    const cookie=await login();db.prepare("UPDATE principal_keys SET revoked_at=? WHERE principal_id='buyer-agent'").run(new Date().toISOString());expect((await call('snapshot',undefined,cookie)).status).toBe(401);
  });
  it('isolates grant details, requests, events and receipts across principals and organizations',async()=>{
    const requestId=await childRequest();
    db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('unrelated','buyer-co','AGENT','SOURCING');db.prepare('INSERT INTO principal_keys VALUES(?,?,?,NULL)').run('unrelated','unrelated',createHash('sha256').update('unrelated-key').digest('hex'));
    for(const token of [keys['supplier-agent'],'unrelated-key']){
      const cookie=await login(token);const data=(await (await call('snapshot',undefined,cookie)).json()).data;expect(data.grants).toEqual([]);expect(data.requests).toEqual([]);expect(data.activity).toEqual([]);expect(data.receipts).toEqual([]);
      expect((await direct('/v1/authority/requests/'+requestId,undefined,token)).http).toBe(403);expect((await direct('/v1/audit',undefined,token)).http).toBe(403);
    }
    expect((await direct('/v1/console',undefined,keys['owner-1'])).data.requests).toEqual([]);
  });
  it('persists parent counteroffer → child acceptance and enforces parent-only/child-only actions through UI proxy',async()=>{
    const id=await childRequest();const buyer=await login();const child=await login(keys['sourcing-agent']);
    expect((await call(`v1/authority/requests/${id}/respond`,{decision:'COUNTEROFFER',offered_scope:scope()},child)).status).toBe(403);
    expect((await call(`v1/authority/requests/${id}/respond`,{decision:'COUNTEROFFER',offered_scope:scope(120000)},buyer)).status).toBe(403);
    expect((await call(`v1/authority/requests/${id}/respond`,{decision:'COUNTEROFFER',offered_scope:scope()},buyer)).status).toBe(200);
    expect((await call(`v1/authority/requests/${id}/accept`,{idempotency_key:'console-accept'},buyer)).status).toBe(403);
    expect((await call(`v1/authority/requests/${id}/accept`,{idempotency_key:'console-accept'},child)).status).toBe(200);
    const state=(await (await call('snapshot',undefined,child)).json()).data;expect(state.requests[0].status).toBe('ACCEPTED');expect(state.grants.some((g:any)=>g.id===state.requests[0].issued_grant_id)).toBe(true);expect(state.activity.some((e:any)=>e.action==='authority.accept')).toBe(true);
  });
  it('rejects a request via canonical service and refuses child rejection',async()=>{
    const id=await childRequest();const child=await login(keys['sourcing-agent']);expect((await call(`v1/authority/requests/${id}/respond`,{decision:'REJECT'},child)).status).toBe(403);
    const buyer=await login();expect((await call(`v1/authority/requests/${id}/respond`,{decision:'REJECT'},buyer)).status).toBe(200);expect((await direct('/v1/authority/requests/'+id)).data.status).toBe('REJECTED');
  });
  it('shows ancestor spending, persisted receipts and revocation without bypassing service enforcement',async()=>{
    const g=(await direct('/v1/grants/grant-root-buyer/delegate',{recipient_principal_id:'sourcing-agent',scope:scope()})).data;
    const purchase={grant_id:g.id,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quote.quote_id,idempotency_key:'console-spend'};
    expect((await direct('/v1/actions/execute',purchase,keys['sourcing-agent'])).status).toBe('OK');
    const owner=await login(keys['owner-1']);let state=(await (await call('snapshot',undefined,owner)).json()).data;expect(state.receipts[0]).toMatchObject({simulated:true,amount_cents:85000});expect(state.budgets.find((b:any)=>b.grant_id==='grant-root-buyer').remaining_budget_cents).toBe(15000);expect(JSON.stringify(state)).not.toMatch(/internal_unit_cost|key_hash|console-test-/);
    expect((await direct('/v1/actions/execute',{...purchase,idempotency_key:'over'},keys['sourcing-agent'])).code).toBe('BUDGET_EXCEEDED');
    const child=await login(keys['sourcing-agent']);expect((await call(`v1/grants/${g.id}/revoke`,{reason:'try'},child)).status).toBe(403);
    expect((await call(`v1/grants/${g.id}/revoke`,{reason:'Reviewed'},owner)).status).toBe(200);state=(await (await call('snapshot',undefined,owner)).json()).data;expect(state.budgets.find((b:any)=>b.grant_id===g.id).authority_code).toBe('GRANT_REVOKED');expect((await direct('/v1/actions/execute',{...purchase,idempotency_key:'after'},keys['sourcing-agent'])).code).toBe('GRANT_REVOKED');
  });
  it('marks expired authority unavailable and denies use even when UI data was previously active',async()=>{
    const g=await childGrant();const child=await login(keys['sourcing-agent']);const s=scope(0);s.expires_at=new Date(Date.now()-1000).toISOString();s.actions=['supplier.quote.request'];db.prepare('UPDATE grants SET scope_json=? WHERE id=?').run(JSON.stringify(s),g.id);
    const state=(await (await call('snapshot',undefined,child)).json()).data;expect(state.budgets[0]).toMatchObject({authority_code:'GRANT_EXPIRED',remaining_budget_cents:null});expect((await direct('/v1/actions/execute',{grant_id:g.id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'expired'},keys['sourcing-agent'])).code).toBe('GRANT_EXPIRED');
  });
});
