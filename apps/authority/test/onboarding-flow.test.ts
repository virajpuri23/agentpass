import { createHash,randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import type { AuthorityScope } from '../../../packages/contracts/src/index.js';
import { createAuthorityApp } from '../src/app.js';
import { AccountService } from '../src/accounts.js';
import { onboardingFromEnvironment,assertOAuthResourceBindings } from '../src/onboarding-config.js';

describe('FIXTURE self-service browser and private runner lifecycle',()=>{
  let db:ReturnType<typeof openDatabase>,server:Server,base:string;
  const nativeFetch=globalThis.fetch,origin='https://agentpass.example';
  const identity={issuer:'https://identity.example/',subject:'person-one',client_id:'chatgpt-client'};
  const policy:AuthorityScope={actions:['supplier.quote.request','supplier.purchase.execute'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:2000,total_budget_cents:2000,expires_at:new Date(Date.now()+3500000).toISOString(),max_delegation_depth:3};
  const secrets=new Map<string,string>();
  const runnerOrganizations:string[]=[];
  let browserSubject:string;
  let fixtureNow:number;
  const json=async(path:string,body?:unknown,token='human.one.token')=>{
    const response=await nativeFetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {http:response.status,...await response.json()};
  };
  const browser=(path:string,options:RequestInit={})=>nativeFetch(base+path,{redirect:'manual',...options});
  const cookie=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0];
  async function login(connection:string){
    const start=await browser(`/onboarding?connection=${connection}`),location=new URL(start.headers.get('location')!);
    expect(location.origin).toBe('https://identity.example');expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    const callback=await browser(`/onboarding/callback?code=fixture-code&state=${location.searchParams.get('state')}`,{headers:{cookie:cookie(start)}});
    return {start,location,callback};
  }
  async function approve(connection:string,budget='20.00'){
    const {callback}=await login(connection);expect(callback.status).toBe(303);
    const session=cookie(callback),review=await browser('/onboarding/approve',{headers:{cookie:session}}),html=await review.text();
    expect(html).toContain('All orders are simulated');expect(html).toContain('value="0.00"');
    const csrf=html.match(/name="csrf" value="([^"]+)"/)![1];
    const response=await browser('/onboarding/approve',{method:'POST',headers:{cookie:session,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,budget})});
    return {response,session,csrf};
  }
  beforeEach(async()=>{
    fixtureNow=Date.now();db=openDatabase(':memory:');await migrateStore(sqliteStore(db),'sqlite');secrets.clear();runnerOrganizations.length=0;browserSubject=identity.subject;
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      if(String(input)==='https://identity.example/oauth/token'){
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({grant_type:'authorization_code',redirect_uri:`${origin}/onboarding/callback`});
        expect((init?.headers as Record<string,string>).authorization).toBe(`Basic ${Buffer.from('consent-client:fixture-client-secret').toString('base64')}`);
        return new Response(JSON.stringify({access_token:'fixture-browser-token'}),{headers:{'content-type':'application/json'}});
      }
      return nativeFetch(input,init);
    });
    const quote={quote_id:'fixture-quote',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,unit_price_cents:500,total_cents:500,currency:'USD' as const,expires_at:new Date(Date.now()+300000).toISOString()};
    server=createAuthorityApp({db,now:()=>new Date(fixtureNow),verifyHumanToken:async(token)=>{if(token!=='human.one.token')throw Error('Invalid fixture token');return identity;},consentBrowser:{origin,issuer:identity.issuer,resource:origin+'/mcp',clientId:'consent-client',clientSecret:'fixture-client-secret',sessionKey:Buffer.alloc(32,1),policy:()=>policy,verifyHumanToken:async()=>({...identity,subject:browserSubject,client_id:'consent-client'})},agentControl:{mcpUrl:origin+'/mcp',runners:[{id:'fixture-runner',keyHash:createHash('sha256').update('fixture-runner-key').digest('hex'),organizationIds:runnerOrganizations}],credentials:{async ensure(ref){if(!secrets.has(ref))secrets.set(ref,randomBytes(32).toString('base64url'));return secrets.get(ref)!;},async read(ref){return secrets.get(ref)!;},async remove(ref){secrets.delete(ref);}}},supplier:{async policy(_p,action){return action!=='supplier.margin.read';},async quote(){return quote;},async getQuote(){return quote;},async fulfill(){return {order_id:'fixture-order'};}}}).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  afterEach(async()=>{vi.restoreAllMocks();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();});
  it('bootstraps, explicitly consents, persists one grant and blocks forged browser approval',async()=>{
    const context=(await json('/v1/onboarding/context')).data;
    expect(context.connection.state).toBe('CONSENT_REQUIRED');expect(db.prepare('SELECT * FROM grants').all()).toHaveLength(0);
    expect((await json('/v1/agents',{approved:true,organization_id:context.organization.id})).status).toBe('DENIED');
    const {response,session,csrf}=await approve(context.connection.id);expect(response.status).toBe(200);
    const active=(await json('/v1/onboarding/context')).data;expect(active.connection).toMatchObject({state:'ACTIVE',scope:{total_budget_cents:2000}});
    expect((await json('/v1/agents?limit=1e0')).http).toBe(400);
    const replay=await browser('/onboarding/approve',{method:'POST',headers:{cookie:session,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,budget:'20.00'})});expect(replay.status).toBe(403);
    expect(db.prepare('SELECT * FROM grants').all()).toHaveLength(1);expect(db.prepare('SELECT * FROM consent_approvals').all()).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain('fixture-client-secret');
  });
  it('denies legacy child issuance to a consented human and keeps managed provisioning available',async()=>{
    const context=(await json('/v1/onboarding/context')).data;
    expect((await approve(context.connection.id)).response.status).toBe(200);
    const active=(await json('/v1/onboarding/context')).data;runnerOrganizations.push(active.organization.id);
    const counts=()=>['principals','principal_keys','grants','child_provisionings','managed_agents','agent_jobs'].map(table=>(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n);
    const before=counts(),secret=randomBytes(32).toString('base64url');
    const legacy=await json(`/v1/grants/${active.connection.grant_id}/provision-child`,{scope:{...active.connection.scope,max_delegation_depth:1},credential_hash:createHash('sha256').update(secret).digest('hex'),idempotency_key:'legacy-human'});
    expect(legacy).toMatchObject({http:403,status:'DENIED',code:'INVALID_REQUEST',reason:'Human OAuth connections must use provision_agent for managed provisioning',next_action:'contact_owner'});
    const alternate=await json(`/v1/grants/${active.connection.grant_id}/provision-child`,{scope:{},credential_hash:'model-selected',idempotency_key:'alternate-human',template_id:'attacker-picked'});
    expect(alternate).toMatchObject({http:403,status:'DENIED',reason:'Human OAuth connections must use provision_agent for managed provisioning',next_action:'contact_owner'});
    expect(counts()).toEqual(before);
    const managed=await json('/v1/agents',{display_name:'Managed fixture child',task:'Request one quote',requested_scope:{...active.connection.scope,max_per_action_cents:1000,total_budget_cents:1000,max_delegation_depth:1},template_id:'sourcing-v1',idempotency_key:'managed-human'});
    expect(managed).toMatchObject({http:200,status:'OK',data:{state:'PROVISIONING'}});
    expect(counts()).toEqual(before.map(count=>count+1));
  });
  it('rejects login state mismatch, cross-account consent, CSRF and over-policy budget',async()=>{
    const context=(await json('/v1/onboarding/context')).data;
    const start=await browser(`/onboarding?connection=${context.connection.id}`);
    expect(start.headers.get('referrer-policy')).toBe('same-origin');
    expect((await browser('/onboarding/callback?code=x&state=forged',{headers:{cookie:cookie(start)}})).status).toBe(403);
    browserSubject='other-person';expect((await login(context.connection.id)).callback.status).toBe(403);browserSubject=identity.subject;
    const {callback}=await login(context.connection.id),session=cookie(callback),html=await (await browser('/onboarding/approve',{headers:{cookie:session}})).text(),csrf=html.match(/name="csrf" value="([^"]+)"/)![1];
    const post=(originHeader:string,budget:string,csrfValue=csrf)=>browser('/onboarding/approve',{method:'POST',headers:{cookie:session,origin:originHeader,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:csrfValue,budget})});
    expect((await post('null','0.00')).status).toBe(403);
    expect((await post('https://attacker.example','0.00')).status).toBe(403);expect((await post(origin,'0.00','forged')).status).toBe(403);expect((await post(origin,'20.01')).status).toBe(403);
    expect(db.prepare('SELECT * FROM grants').all()).toHaveLength(0);
  });
  it('runs consent → provision → private delivery → child readiness → purchase → result → revoke',async()=>{
    const context=(await json('/v1/onboarding/context')).data;runnerOrganizations.push(context.organization.id);
    expect((await approve(context.connection.id)).response.status).toBe(200);
    const active=(await json('/v1/onboarding/context')).data;
    const input={display_name:'Fixture sourcing child',task:'Buy one permitted simulated product',requested_scope:{...active.connection.scope,max_per_action_cents:1000,total_budget_cents:1000,max_delegation_depth:1},template_id:'sourcing-v1',idempotency_key:'fixture-provision'};
    const provisioned=(await json('/v1/agents',input)).data;expect(provisioned.state).toBe('PROVISIONING');
    expect((await json('/v1/agents',input)).data.agent_id).toBe(provisioned.agent_id);
    const claim=(await json('/internal/agent-jobs/claim',{idempotency_key:'fixture-claim'},'fixture-runner-key')).data.job;
    const delivered=(await json(`/internal/agent-jobs/${claim.job_id}/credential`,{claim_id:claim.claim_id},'fixture-runner-key')).data;
    expect(delivered.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(JSON.stringify(provisioned)).not.toContain(delivered.credential);
    expect((await json(`/v1/agent-runs/${claim.job_id}/ready`,{claim_id:claim.claim_id},delivered.credential)).data.state).toBe('READY');
    const grant=provisioned.authority.grant_id;
    const quote=await json('/v1/actions/execute',{grant_id:grant,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,idempotency_key:'fixture-quote'},delivered.credential);expect(quote.status).toBe('OK');
    const purchase={grant_id:grant,action:'supplier.purchase.execute',supplier_id:'supplier-co',sku_id:'PACK-500',quote_id:quote.data.quote_id,idempotency_key:'fixture-purchase'};
    expect((await json('/v1/actions/execute',purchase,delivered.credential)).data).toMatchObject({amount_cents:500,simulated:true});
    expect((await json('/v1/actions/execute',purchase,delivered.credential)).status).toBe('OK');
    expect((await json(`/internal/agent-jobs/${claim.job_id}/result`,{claim_id:claim.claim_id,outcome:'COMPLETED',summary:'Fixture complete'},'fixture-runner-key')).data.execution_state).toBe('COMPLETED');
    const ledger=db.prepare("SELECT grant_id,SUM(amount_cents) total FROM ledger_entries WHERE state='COMMITTED' GROUP BY grant_id").all() as Array<{total:number}>;expect(ledger).toHaveLength(2);expect(ledger.every(x=>x.total===500)).toBe(true);
    expect((await json('/v1/onboarding/context')).data.connection.grant_id).toBe(active.connection.grant_id);
    expect((await json(`/v1/agents/${provisioned.agent_id}/revoke`,{reason:'Fixture complete',idempotency_key:'revoke'})).data.state).toBe('REVOKED');
    expect((await json('/v1/actions/execute',{...purchase,idempotency_key:'after-revoke'},delivered.credential)).status).toBe('DENIED');
    const persisted=JSON.stringify(db.prepare('SELECT * FROM audit_events').all());expect(persisted).not.toContain(delivered.credential);expect(secrets.size).toBe(0);
  });
  it.each(['expired','invalid'])('denies the delivered child and descendants with an %s lease without control polling',async(lease)=>{
    const context=(await json('/v1/onboarding/context')).data;runnerOrganizations.push(context.organization.id);
    expect((await approve(context.connection.id,'0')).response.status).toBe(200);
    const active=(await json('/v1/onboarding/context')).data;
    const agent=(await json('/v1/agents',{display_name:'Lease fixture',task:'Request a quote',requested_scope:{...active.connection.scope,max_delegation_depth:1},template_id:'sourcing-v1',idempotency_key:'lease-fixture'})).data;
    const claim=(await json('/internal/agent-jobs/claim',{idempotency_key:'lease-claim'},'fixture-runner-key')).data.job;
    const delivery=(await json(`/internal/agent-jobs/${claim.job_id}/credential`,{claim_id:claim.claim_id},'fixture-runner-key')).data;
    expect((await json('/v1/me',undefined,delivery.credential)).http).toBe(200);
    const descendantSecret=randomBytes(32).toString('base64url');
    expect((await json(`/v1/grants/${agent.authority.grant_id}/provision-child`,{scope:{...agent.authority.scope,max_delegation_depth:0},credential_hash:createHash('sha256').update(descendantSecret).digest('hex'),idempotency_key:'lease-descendant'},delivery.credential)).http).toBe(200);
    expect((await json('/v1/me',undefined,descendantSecret)).http).toBe(200);
    if(lease==='expired')fixtureNow+=31000;
    else db.prepare('UPDATE agent_jobs SET lease_expires_at=? WHERE id=?').run('invalid',claim.job_id);
    expect((await json('/v1/me',undefined,delivery.credential)).http).toBe(401);
    expect((await json('/v1/me',undefined,descendantSecret)).http).toBe(401);
    expect((await json('/v1/actions/execute',{grant_id:agent.authority.grant_id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,idempotency_key:'expired-lease'},delivery.credential)).http).toBe(401);
    expect(db.prepare('SELECT * FROM purchases').all()).toHaveLength(0);
  });
  it('denies a connection and its child immediately after persisted membership removal',async()=>{
    const context=(await json('/v1/onboarding/context')).data;expect((await approve(context.connection.id,'0')).response.status).toBe(200);
    const active=(await json('/v1/onboarding/context')).data;runnerOrganizations.push(active.organization.id);
    const child=(await json('/v1/agents',{display_name:'Membership fixture child',task:'Request a quote',requested_scope:{...active.connection.scope,max_delegation_depth:1},template_id:'sourcing-v1',idempotency_key:'membership-child'})).data;
    const claim=(await json('/internal/agent-jobs/claim',{idempotency_key:'membership-claim'},'fixture-runner-key')).data.job;
    const secret=(await json(`/internal/agent-jobs/${claim.job_id}/credential`,{claim_id:claim.claim_id},'fixture-runner-key')).data.credential;
    expect((await json('/v1/me',undefined,secret)).status).toBe('OK');
    const accounts=new AccountService(sqliteStore(db));const account=await accounts.accountForIdentity(identity);
    db.prepare("UPDATE memberships SET state='INACTIVE' WHERE id=?").run(account!.membership_id);
    expect((await json('/v1/me')).http).toBe(401);
    expect((await json('/v1/actions/execute',{grant_id:child.authority.grant_id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:1,idempotency_key:'after-removal'},secret)).status).toBe('DENIED');
  });
  it('fails closed for an invalid token or unavailable account persistence',async()=>{
    expect((await json('/v1/onboarding/context',undefined,'forged.human.token')).http).toBe(401);
    expect(db.prepare('SELECT * FROM accounts').all()).toHaveLength(0);
    expect((await json('/v1/onboarding/context')).status).toBe('OK');
    db.prepare('ALTER TABLE accounts RENAME TO unavailable_accounts').run();
    expect((await json('/v1/onboarding/context')).http).toBe(503);
    expect(db.prepare('SELECT * FROM grants').all()).toHaveLength(0);
  });
});

describe('onboarding environment boundary',()=>{
  it('requires persisted exact client/resource bindings before OAuth startup',async()=>{
    const db=openDatabase(':memory:'),store=sqliteStore(db),env={MCP_USE_OAUTH_SUPABASE_URL:'https://identity.example',MCP_PUBLIC_URL:'https://agentpass.example/mcp',AGENTPASS_OAUTH_CLIENT_IDS:'host-client',AGENTPASS_CONSENT_CLIENT_ID:'consent-client'};
    try{
      await migrateStore(store,'sqlite');
      await expect(assertOAuthResourceBindings(store,env)).rejects.toThrow('mapping is missing');
      db.prepare('INSERT INTO oauth_resource_clients(client_id,resource) VALUES(?,?)').run('host-client',env.MCP_PUBLIC_URL);
      await expect(assertOAuthResourceBindings(store,env)).rejects.toThrow('mapping is missing');
      db.prepare('INSERT INTO oauth_resource_clients(client_id,resource) VALUES(?,?)').run('consent-client',env.MCP_PUBLIC_URL);
      await expect(assertOAuthResourceBindings(store,env)).resolves.toBeUndefined();
      db.prepare('UPDATE oauth_resource_clients SET resource=? WHERE client_id=?').run('https://other.example/mcp','host-client');
      await expect(assertOAuthResourceBindings(store,env)).rejects.toThrow('mapping is missing');
    }finally{db.close();}
  });
  it('keeps legacy startup and requires complete OAuth consent configuration',()=>{
    expect(onboardingFromEnvironment({})).toEqual({});
    expect(()=>onboardingFromEnvironment({AGENTPASS_CONSENT_CLIENT_ID:'client'})).toThrow();
    const oauth={MCP_USE_OAUTH_SUPABASE_URL:'https://identity.example',MCP_PUBLIC_URL:'https://agentpass.example/mcp',AGENTPASS_OAUTH_CLIENT_IDS:'chatgpt-client'};
    expect(()=>onboardingFromEnvironment(oauth)).toThrow('OAuth onboarding requires trusted consent and Supabase login settings');
    const env={...oauth,AGENTPASS_CONSENT_CLIENT_ID:'consent-client',AGENTPASS_CONSENT_CLIENT_SECRET:'fixture',AGENTPASS_CONSENT_SESSION_KEY:'a'.repeat(64),SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
    const options=onboardingFromEnvironment(env);
    expect(options.consentBrowser?.policy()).toMatchObject({supplier_ids:[],sku_ids:[],total_budget_cents:0});
    expect(options.supabaseLogin).toBeDefined();
    expect(()=>onboardingFromEnvironment({...env,AGENTPASS_CONSENT_SESSION_KEY:'bad'})).toThrow();
    expect(()=>onboardingFromEnvironment({...env,AGENTPASS_ONBOARDING_MAX_PER_ACTION_CENTS:'1'})).toThrow();
    expect(()=>onboardingFromEnvironment({...oauth,AGENTPASS_CONSENT_CLIENT_ID:'consent-client'})).toThrow('OAuth onboarding requires trusted consent and Supabase login settings');
  });

  it('rejects orphaned runner and credential-store settings without OAuth',()=>{
    for(const env of [
      {AGENTPASS_CREDENTIAL_STORE:'vault'},
      {AGENTPASS_RUNNERS_JSON:'[]'},
      {AGENTPASS_ONBOARDING_RUNNER_ID:'trusted-runner'},
    ])expect(()=>onboardingFromEnvironment(env)).toThrow('Agent control requires OAuth configuration');
  });
});
