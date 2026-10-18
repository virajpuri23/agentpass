import { createHash,randomBytes,randomUUID } from 'node:crypto';
import express from 'express';
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import { openDatabase } from '../../../db/database.js';
import { migrateStore } from '../../../db/migrations.js';
import { sqliteStore } from '../../../db/store.js';
import { AccountService } from '../src/accounts.js';
import { createAuthorityApp } from '../src/app.js';
import { ConsentService } from '../src/consent.js';
import { AgentControl,mountAgentControl,agentControlFromEnvironment,type RunnerAdmission } from '../src/agent-control.js';
import { AuthorityEngine,Denial } from '../src/engine.js';
import type { CredentialStore } from '../src/credential-store.js';
import type { AuthorityScope,Principal } from '../../../packages/contracts/src/index.js';

class FixtureCredentials implements CredentialStore {
  readonly secrets=new Map<string,string>();
  failAfterCreate=false;
  async ensure(reference:string){let secret=this.secrets.get(reference);if(!secret){secret=randomBytes(32).toString('base64url');this.secrets.set(reference,secret);}if(this.failAfterCreate)throw new Error('FIXTURE lost store reply');return secret;}
  async read(reference:string){const secret=this.secrets.get(reference);if(!secret)throw new Error('Missing fixture secret');return secret;}
  async remove(reference:string){this.secrets.delete(reference);}
}

describe('managed agent control (FIXTURE credential store and runner)',()=>{
  let db:ReturnType<typeof openDatabase>,engine:AuthorityEngine,control:AgentControl,secrets:FixtureCredentials,parent:Principal,other:Principal,runner:RunnerAdmission,now:number,scope:AuthorityScope;
  const runnerSecret=randomBytes(32).toString('base64url');
  const key=(s:string)=>createHash('sha256').update(s).digest('hex');
  const input=(id=randomUUID())=>({display_name:'Sourcing agent',task:'Request a simulated quote',requested_scope:{...scope,max_delegation_depth:0},template_id:'sourcing-v1',idempotency_key:id});
  const accept=async(subject:string)=>{
    const account=await new AccountService(engine.db,engine.now).bootstrap({issuer:'https://fixture.example/',subject,client_id:'fixture-host'});
    const consent=new ConsentService(engine,()=>scope,engine.now);
    const request=await consent.request(account.account_id,account.connection.id,scope);
    await consent.approve(account.account_id,request.id);
    return engine.principal(account.connection.principal_id);
  };
  beforeEach(async()=>{
    now=Date.parse('2026-10-17T23:00:00Z');db=openDatabase(':memory:');const store=sqliteStore(db);await migrateStore(store,'sqlite');
    const supplier={policy:async()=>({decision:'ALLOW'}),quote:async()=>({quote_id:'quote-fixture',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,unit_price_cents:170,total_cents:85000,currency:'USD',expires_at:new Date(now+300000).toISOString()}),getQuote:async()=>{throw new Error('Unexpected fixture purchase');},fulfill:async()=>{throw new Error('Unexpected fixture purchase');}};
    engine=new AuthorityEngine(store,supplier as any,()=>new Date(now));
    scope={actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:new Date(now+3600000).toISOString(),max_delegation_depth:2};
    parent=await accept('first-person');other=await accept('second-person');secrets=new FixtureCredentials();
    runner={id:'fixture-runner',keyHash:key(runnerSecret),organizationIds:[parent.organization_id]};
    control=new AgentControl(engine,{credentials:secrets,mcpUrl:'http://127.0.0.1:3001/mcp',runners:[runner]});
  });
  afterEach(()=>db.close());
  async function delivered(){const agent=await control.provision(parent,input());const claim=(await control.claim(runner,{idempotency_key:randomUUID()})).job!;const delivery=await control.deliver(runner,claim.job_id,{claim_id:claim.claim_id});return {agent,claim,delivery};}
  async function authorityHttp(){
    const server=createAuthorityApp({db:sqliteStore(db),supplier:engine.supplier,now:()=>new Date(now),agentControl:control.options}).listen(0,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const url=`http://127.0.0.1:${(server.address() as any).port}`;
    const post=(path:string,body:unknown,token=runnerSecret)=>fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
    return {post,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
  }

  it('persists one child/job across concurrent retries; only its credential can mark readiness and execute',async()=>{
    const request=input();const agents=await Promise.all([control.provision(parent,request),control.provision(parent,request)]);
    expect(agents[0]).toEqual(agents[1]);expect(agents[0].state).toBe('PROVISIONING');
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get() as any).n).toBe(1);
    const claim=(await control.claim(runner,{idempotency_key:'claim-one'})).job!;
    expect((await control.claim(runner,{idempotency_key:'claim-one'})).job).toEqual(claim);
    const delivery=await control.deliver(runner,claim.job_id,{claim_id:claim.claim_id});const child=await engine.authenticate(delivery.credential);
    await expect(control.ready(parent,claim.job_id,{claim_id:claim.claim_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    expect((await control.ready(child,claim.job_id,{claim_id:claim.claim_id})).state).toBe('READY');
    const quote=await engine.execute(child,{grant_id:claim.grant_id,action:'supplier.quote.request',supplier_id:'supplier-co',sku_id:'PACK-500',quantity:500,idempotency_key:'fixture-quote'});
    expect(quote).toMatchObject({total_cents:85000});
    expect((await control.result(runner,claim.job_id,{claim_id:claim.claim_id,outcome:'COMPLETED',summary:'Fixture quote received'})).execution_state).toBe('COMPLETED');
    expect((await control.get(parent,agents[0].agent_id)).execution_state).toBe('COMPLETED');
    const publicState=JSON.stringify(await control.list(parent,{}));expect(publicState).not.toContain(delivery.credential);expect(publicState).not.toContain('Request a simulated quote');
  });
  it('denies forged fields, input rebinding, widening, foreign records/cursors and unadmitted runners',async()=>{
    const request=input(),agent=await control.provision(parent,request);
    await expect(control.provision(parent,{...request,organization_id:other.organization_id})).rejects.toThrow();
    await expect(control.provision(parent,{...request,task:'changed'})).rejects.toMatchObject({result:{code:'ALREADY_EXECUTED'}});
    await expect(control.provision(parent,{...input(),requested_scope:{...scope,total_budget_cents:1}})).rejects.toMatchObject({result:{code:'OUTSIDE_PARENT_SCOPE'}});
    await expect(control.get(other,agent.agent_id)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    await expect(control.list(other,{cursor:agent.agent_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    expect(await control.claim({...runner,id:'foreign',organizationIds:[other.organization_id]},{idempotency_key:'foreign'})).toEqual({job:null});
    expect(()=>control.authenticateRunner('wrong')).toThrow(Denial);
  });
  it('recovers a lost secret-store reply and an issuance/job failure without orphan identities',async()=>{
    secrets.failAfterCreate=true;const agent=await control.provision(parent,input());expect(agent.state).toBe('PENDING');expect(secrets.secrets.size).toBe(1);
    const principalCount=(db.prepare('SELECT COUNT(*) AS n FROM principals').get() as any).n;
    secrets.failAfterCreate=false;db.exec("CREATE TRIGGER fixture_fail_job BEFORE INSERT ON agent_jobs BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(control.advance(agent.agent_id)).rejects.toThrow('fixture failure');
    expect((db.prepare('SELECT COUNT(*) AS n FROM principals').get() as any).n).toBe(principalCount);
    expect((db.prepare('SELECT COUNT(*) AS n FROM child_provisionings').get() as any).n).toBe(0);
    db.exec('DROP TRIGGER fixture_fail_job');const recovered=await control.get(parent,agent.agent_id);expect(recovered.state).toBe('PROVISIONING');expect(secrets.secrets.size).toBe(1);
    const restarted=new AgentControl(engine,control.options);expect(await restarted.get(parent,agent.agent_id)).toEqual(recovered);
  });
  it('grants one live lease and preserves claim idempotency after an undelivered lease is reassigned',async()=>{
    await control.provision(parent,input());await control.provision(parent,input());
    const [a,b]=await Promise.all([control.claim(runner,{idempotency_key:'first'}),control.claim(runner,{idempotency_key:'second'})]);
    expect(a.job!.job_id).not.toBe(b.job!.job_id);
    expect(await control.claim(runner,{idempotency_key:'third'})).toEqual({job:null});
    now+=31000;const reclaimed=await control.claim(runner,{idempotency_key:'new'});expect(reclaimed.job).not.toBeNull();
    expect(reclaimed.job!.launch_id).toBe([a.job!,b.job!].find(j=>j.job_id===reclaimed.job!.job_id)!.launch_id);
    const old=[a.job!,b.job!].find(j=>j.job_id===reclaimed.job!.job_id)!;
    await expect(control.claim(runner,{idempotency_key:old.claim_id===a.job!.claim_id?'first':'second'})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    await expect(control.deliver(runner,reclaimed.job!.job_id,{claim_id:old.claim_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
  });
  it('revokes authority after delivered lease loss and never reassigns it',async()=>{
    const {agent,claim,delivery}=await delivered();now+=31000;
    await expect(control.heartbeat(runner,claim.job_id,{claim_id:claim.claim_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    await expect(engine.authenticate(delivery.credential)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    expect((await control.get(parent,agent.agent_id)).state).toBe('FAILED');expect(secrets.secrets.size).toBe(0);
    expect(await control.claim(runner,{idempotency_key:'new-runner-attempt'})).toEqual({job:null});
  });
  it('recovers pending work at startup and cleans expired delivery without polling',async()=>{
    secrets.failAfterCreate=true;const agent=await control.provision(parent,input());expect(agent.state).toBe('PENDING');
    secrets.failAfterCreate=false;
    vi.useFakeTimers();
    const stop=await control.startReconciliation();
    try{
      expect((db.prepare('SELECT state FROM managed_agents WHERE id=?').get(agent.agent_id) as any).state).toBe('PROVISIONING');
      const claim=(await control.claim(runner,{idempotency_key:'background-claim'})).job!;
      const delivery=await control.deliver(runner,claim.job_id,{claim_id:claim.claim_id});
      expect(await engine.authenticate(delivery.credential)).toBeDefined();
      const remove=secrets.remove.bind(secrets);secrets.remove=async()=>{throw new Error('FIXTURE cleanup unavailable');};
      now+=31000;await vi.advanceTimersByTimeAsync(10000);
      expect((db.prepare('SELECT state FROM managed_agents WHERE id=?').get(agent.agent_id) as any).state).toBe('FAILED');
      expect(secrets.secrets.size).toBe(1);secrets.remove=remove;
      await vi.advanceTimersByTimeAsync(10000);
      expect(secrets.secrets.size).toBe(0);
      await expect(engine.authenticate(delivery.credential)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    }finally{await stop();vi.useRealTimers();}
  });
  it('revocation is terminal, removes the secret, and blocks late child readiness/result',async()=>{
    const {agent,claim,delivery}=await delivered();const child=await engine.authenticate(delivery.credential);
    expect((await control.revoke(parent,agent.agent_id,{reason:'stop',idempotency_key:'revoke'})).state).toBe('REVOKED');
    expect((await control.revoke(parent,agent.agent_id,{reason:'stop',idempotency_key:'revoke'})).state).toBe('REVOKED');
    await expect(control.ready(child,claim.job_id,{claim_id:claim.claim_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    await expect(control.result(runner,claim.job_id,{claim_id:claim.claim_id,outcome:'COMPLETED',summary:''})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    await expect(engine.authenticate(delivery.credential)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});expect(secrets.secrets.size).toBe(0);
  });
  it('fails closed on membership removal and commits invalidation despite runner denial',async()=>{
    const {agent,claim,delivery}=await delivered();db.prepare("UPDATE memberships SET state='INACTIVE' WHERE organization_id=?").run(parent.organization_id);
    await expect(control.deliver(runner,claim.job_id,{claim_id:claim.claim_id})).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    expect((db.prepare('SELECT state FROM managed_agents WHERE id=?').get(agent.agent_id) as any).state).toBe('FAILED');
    await expect(engine.authenticate(delivery.credential)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
  });
  it('does not accept completion before child readiness or changed terminal results',async()=>{
    const {claim,delivery}=await delivered(),result={claim_id:claim.claim_id,outcome:'COMPLETED',summary:'safe'};
    await expect(control.result(runner,claim.job_id,result)).rejects.toMatchObject({result:{code:'INVALID_REQUEST'}});
    await control.ready(await engine.authenticate(delivery.credential),claim.job_id,{claim_id:claim.claim_id});
    expect(await control.result(runner,claim.job_id,result)).toEqual(await control.result(runner,claim.job_id,result));
    await expect(control.result(runner,claim.job_id,{...result,summary:'changed'})).rejects.toMatchObject({result:{code:'ALREADY_EXECUTED'}});
    expect(JSON.stringify(db.prepare('SELECT * FROM agent_jobs').all())).not.toContain('safe');
  });
  it('records failed results over HTTP and replays only the identical result for the live claim',async()=>{
    const {agent,claim}=await delivered(),http=await authorityHttp(),result={claim_id:claim.claim_id,outcome:'FAILED' as const,summary:'fixture failed'};
    try{
      const firstResponse=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,result);
      expect(firstResponse.status).toBe(200);const first=await firstResponse.json();
      expect(first).toMatchObject({status:'OK',data:{agent_id:agent.agent_id,state:'FAILED',execution_state:'FAILED'}});
      const replay=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,result);
      expect(replay.status).toBe(200);expect(await replay.json()).toEqual(first);
      const changed=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,{...result,summary:'changed'});
      expect(changed.status).toBe(409);expect(await changed.json()).toMatchObject({code:'ALREADY_EXECUTED'});
      const crossClaim=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,{...result,claim_id:'another-claim'});
      expect(crossClaim.status).toBe(404);expect(await crossClaim.json()).toMatchObject({code:'INVALID_CALLER'});
      now+=31000;
      const expired=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,result);
      expect(expired.status).toBe(403);expect(await expired.json()).toMatchObject({code:'INVALID_CALLER'});
    }finally{await http.close();}
  });
  it('denies failed-result replay after the managed agent is revoked over HTTP',async()=>{
    const {agent,claim}=await delivered(),http=await authorityHttp(),result={claim_id:claim.claim_id,outcome:'FAILED' as const,summary:'fixture failed'};
    const parentCredential='fixture-parent-http-key';
    db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)').run(randomUUID(),parent.id,key(parentCredential));
    try{
      const failed=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,result);
      expect(failed.status).toBe(200);
      const revoked=await http.post(`/v1/agents/${agent.agent_id}/revoke`,{reason:'fixture revoke',idempotency_key:'fixture-revoke'},parentCredential);
      expect(revoked.status).toBe(200);expect(await revoked.json()).toMatchObject({status:'OK',data:{state:'REVOKED'}});
      const replay=await http.post(`/internal/agent-jobs/${claim.job_id}/result`,result);
      expect(replay.status).toBe(403);expect(await replay.json()).toMatchObject({code:'INVALID_CALLER'});
    }finally{await http.close();}
  });
  it('bounds pending launches, lifetimes, attempts and cleans expired pending secrets',async()=>{
    await expect(control.provision(parent,{...input(),requested_scope:{...scope,expires_at:new Date(now+3600001).toISOString()}})).rejects.toMatchObject({result:{code:'OUTSIDE_PARENT_SCOPE'}});
    secrets.failAfterCreate=true;for(let n=0;n<3;n++)await control.provision(parent,input());
    await expect(control.provision(parent,input())).rejects.toMatchObject({result:{code:'INSUFFICIENT_SCOPE'}});
    now+=300001;const list=await control.list(parent,{});expect(list.agents.every(a=>a.state==='FAILED')).toBe(true);expect(secrets.secrets.size).toBe(0);
  });
  it('persists denied provisioning attempts and exhausts three undelivered claims safely',async()=>{
    for(let n=0;n<5;n++)await expect(control.provision(parent,{...input(),requested_scope:{...scope,total_budget_cents:1}})).rejects.toMatchObject({result:{code:'OUTSIDE_PARENT_SCOPE'}});
    await expect(control.provision(parent,input())).rejects.toMatchObject({result:{code:'INSUFFICIENT_SCOPE'}});
    now+=60001;const agent=await control.provision(parent,input());
    for(let n=0;n<3;n++){expect((await control.claim(runner,{idempotency_key:`try-${n}`})).job).not.toBeNull();now+=31000;}
    expect(await control.claim(runner,{idempotency_key:'fourth'})).toEqual({job:null});
    expect((await control.get(parent,agent.agent_id)).state).toBe('FAILED');
  });
  it('cleans a failed secret deletion on later polling and preserves completed execution on revoke',async()=>{
    const {agent,claim,delivery}=await delivered();await control.ready(await engine.authenticate(delivery.credential),claim.job_id,{claim_id:claim.claim_id});
    await control.result(runner,claim.job_id,{claim_id:claim.claim_id,outcome:'COMPLETED',summary:''});
    const remove=secrets.remove.bind(secrets);secrets.remove=async()=>{throw new Error('FIXTURE store outage');};
    expect(await control.revoke(parent,agent.agent_id,{reason:'stop',idempotency_key:'revoke'})).toMatchObject({state:'REVOKED',execution_state:'COMPLETED'});
    await expect(engine.authenticate(delivery.credential)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});
    expect(secrets.secrets.size).toBe(1);secrets.remove=remove;expect((await control.get(parent,agent.agent_id)).state).toBe('REVOKED');expect(secrets.secrets.size).toBe(0);
  });
  it('private HTTP delivery requires runner auth, returns no-store, and is absent from public output',async()=>{
    const app=express();app.use(express.json());app.use('/v1',async(req,res,next)=>{try{res.locals.principal=req.headers.authorization===`Bearer ${runnerSecret}`?parent:await engine.authenticate(req.headers.authorization!.slice(7));next();}catch(e){next(e);}});
    mountAgentControl(app,engine,control.options);app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof Denial?error.http:503).json(error instanceof Denial?error.result:{status:'ERROR',code:'SERVICE_UNAVAILABLE'}));
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}`;
    const post=async(path:string,body:unknown,token=runnerSecret)=>fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
    try{
      const response=await post('/v1/agents',input());expect(response.status).toBe(200);const agent=(await response.json() as any).data;expect(agent.state).toBe('PROVISIONING');
      const list=await fetch(url+'/v1/agents?limit=1',{headers:{authorization:`Bearer ${runnerSecret}`}});expect((await list.json() as any).data.agents).toHaveLength(1);
      expect((await post('/internal/agent-jobs/claim',{idempotency_key:'bad'},'wrong')).status).toBe(401);
      const claim=(await (await post('/internal/agent-jobs/claim',{idempotency_key:'http'})).json() as any).data.job;
      const delivery=await post(`/internal/agent-jobs/${claim.job_id}/credential`,{claim_id:claim.claim_id});expect(delivery.headers.get('cache-control')).toBe('no-store');const secret=(await delivery.json() as any).data.credential;
      expect(JSON.stringify(agent)).not.toContain(secret);
      const ready=await post(`/v1/agent-runs/${claim.job_id}/ready`,{claim_id:claim.claim_id},secret);expect((await ready.json() as any).data.state).toBe('READY');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('requires explicit private storage config and rejects unsafe runner admission',async()=>{
    expect(agentControlFromEnvironment(engine,{}).credentials).toBeUndefined();
    await expect(new AgentControl(engine,{mcpUrl:'http://localhost/mcp',runners:[]}).provision(parent,input())).rejects.toMatchObject({result:{code:'SERVICE_UNAVAILABLE'}});
    expect(()=>agentControlFromEnvironment(engine,{AGENTPASS_CREDENTIAL_STORE:'plaintext'})).toThrow();
    expect(()=>agentControlFromEnvironment(engine,{AGENTPASS_RUNNERS_JSON:'[{"id":"runner","keyHash":"bad","organizationIds":["org"]}]'})).toThrow();
    expect(()=>agentControlFromEnvironment(engine,{NODE_ENV:'production',MCP_PUBLIC_URL:'http://remote.example/mcp'})).toThrow();
  });
});

describe.skipIf(!process.env.AGENTPASS_RUNNER_TEST_DATABASE_URL)('managed agent PostgreSQL persistence (FIXTURE runner/store)',()=>{
  it('applies private migrations, persists issuance/job atomically, and resumes after reopening the database',async()=>{
    const {postgresStore}=await import('../../../db/postgres.js');
    const url=new URL(process.env.AGENTPASS_RUNNER_TEST_DATABASE_URL!);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.endsWith('_test'))throw new Error('Disposable local runner database required');
    const pg=postgresStore(url.href),now=()=>new Date('2026-10-17T23:00:00Z'),secrets=new FixtureCredentials();
    let id:string,parent:Principal;
    const options={credentials:secrets,mcpUrl:'http://127.0.0.1:3001/mcp',runners:[]};
    try{
      await pg.migrate();await migrateStore(pg.store,'postgres',now);
      const engine=new AuthorityEngine(pg.store,{} as any,now),account=await new AccountService(pg.store,now).bootstrap({issuer:'https://fixture.example/',subject:randomUUID(),client_id:'pg-fixture'});
      const scope:AuthorityScope={actions:['supplier.quote.request'],supplier_ids:['supplier-co'],sku_ids:['PACK-500'],max_per_action_cents:0,total_budget_cents:0,expires_at:'2026-10-18T00:00:00Z',max_delegation_depth:1};
      const consent=new ConsentService(engine,()=>scope,now),request=await consent.request(account.account_id,account.connection.id,scope);await consent.approve(account.account_id,request.id);parent=await engine.principal(account.connection.principal_id);
      const control=new AgentControl(engine,options),input={display_name:'Postgres worker',task:'Fixture quote',requested_scope:{...scope,max_delegation_depth:0},template_id:'sourcing-v1',idempotency_key:randomUUID()};
      const [first,replay]=await Promise.all([control.provision(parent,input),control.provision(parent,input)]);expect(first).toEqual(replay);id=first.agent_id;
      expect(first.state).toBe('PROVISIONING');expect(Number((await pg.store.prepare('SELECT COUNT(*) AS n FROM agent_jobs WHERE agent_id=?').get(id)).n)).toBe(1);
      for(const table of ['managed_agents','agent_jobs','agent_job_claims','agent_provision_attempts'])expect((await pg.store.prepare("SELECT relrowsecurity FROM pg_class WHERE oid=?::regclass").get(`agentpass.${table}`)).relrowsecurity).toBe(true);
    }finally{await pg.close();}
    const reopened=postgresStore(url.href);
    try{const control=new AgentControl(new AuthorityEngine(reopened.store,{} as any,now),options);expect((await control.get(parent!,id!)).state).toBe('PROVISIONING');await expect(control.get({...parent!,id:'other'},id!)).rejects.toMatchObject({result:{code:'INVALID_CALLER'}});}finally{await reopened.close();}
  });
});
